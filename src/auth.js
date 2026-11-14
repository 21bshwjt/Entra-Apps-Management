'use strict';

const express = require('express');
const msal = require('@azure/msal-node');

const GRAPH_SCOPES = [
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/User.ReadBasic.All',
  'https://graph.microsoft.com/Application.ReadWrite.All',
];
const LOGIN_SCOPES = ['openid', 'profile', 'offline_access', ...GRAPH_SCOPES];

const cca = new msal.ConfidentialClientApplication({
  auth: {
    clientId: process.env.CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
    clientSecret: process.env.CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      piiLoggingEnabled: false,
      logLevel: msal.LogLevel.Warning,
      loggerCallback: (_lvl, msg) => console.warn('[msal]', msg),
    },
  },
});
const crypto = new msal.CryptoProvider();
const { securityLog, isSameOrigin } = require('./security');

/** Sessions end after this long without activity (also the cookie lifetime). */
const SESSION_IDLE_MS = 60 * 60 * 1000;
/** ...and after this long in total, even when active. */
const SESSION_MAX_MS = Math.min(Math.max(parseFloat(process.env.SESSION_MAX_HOURS) || 8, 1), 24) * 60 * 60 * 1000;

/**
 * Tokens (including refresh tokens) live in MSAL's in-memory cache. Track when each
 * account was last used and remove it once its session can no longer be valid, so
 * tokens don't stay in memory after users walk away.
 */
const activity = new Map(); // homeAccountId -> { lastSeen, loginAt }

async function dropAccount(homeAccountId) {
  activity.delete(homeAccountId);
  try {
    const account = await cca.getTokenCache().getAccountByHomeId(homeAccountId);
    if (account) await cca.getTokenCache().removeAccount(account);
  } catch { /* ignore */ }
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, a] of activity) {
    if (now - a.lastSeen > SESSION_IDLE_MS || now - a.loginAt > SESSION_MAX_MS) await dropAccount(id);
  }
  // Anything in the cache that no session is tracking (e.g. a half-finished sign-in) is removed too.
  try {
    for (const account of await cca.getTokenCache().getAllAccounts()) {
      if (!activity.has(account.homeAccountId)) await cca.getTokenCache().removeAccount(account);
    }
  } catch { /* ignore */ }
}, 5 * 60 * 1000).unref();

const router = express.Router();

router.get('/signin', async (req, res, next) => {
  try {
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    req.session.authFlow = { verifier, state };
    const url = await cca.getAuthCodeUrl({
      scopes: LOGIN_SCOPES,
      redirectUri: process.env.REDIRECT_URI,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
      prompt: 'select_account',
    });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

router.get('/callback', async (req, res, next) => {
  try {
    const flow = req.session.authFlow;
    if (req.query.error) {
      return res.status(401).send(`Sign-in failed: ${escapeHtml(String(req.query.error_description || req.query.error))}`);
    }
    if (!flow || !req.query.state || req.query.state !== flow.state) {
      return res.status(400).send('Invalid sign-in state. <a href="/">Try again</a>.');
    }
    const result = await cca.acquireTokenByCode({
      code: String(req.query.code),
      scopes: LOGIN_SCOPES,
      redirectUri: process.env.REDIRECT_URI,
      codeVerifier: flow.verifier,
    });

    // Prevent session fixation: issue a new session id after login.
    req.session.regenerate((err) => {
      if (err) return next(err);
      const now = Date.now();
      req.session.user = {
        homeAccountId: result.account.homeAccountId,
        oid: result.account.idTokenClaims?.oid,
        name: result.account.name,
        username: result.account.username,
        loginAt: now,
      };
      activity.set(result.account.homeAccountId, { lastSeen: now, loginAt: now });
      req.session.save((e) => (e ? next(e) : res.redirect('/')));
    });
  } catch (err) {
    next(err);
  }
});

// Sign-out is a POST from the portal's own page, so other sites can't sign users out.
router.get('/signout', (req, res) => res.redirect('/'));

router.post('/signout', async (req, res) => {
  if (!isSameOrigin(req)) {
    securityLog(req, 'signout_bad_origin', { origin: req.get('Origin') || null, fetchSite: req.get('Sec-Fetch-Site') || null });
    return res.status(403).type('text/plain').send('Sign-out must be started from the portal. Go back and use the Sign out button.');
  }
  const homeId = req.session?.user?.homeAccountId;
  if (homeId) await dropAccount(homeId);
  req.session.destroy(() => {
    const logout = new URL(`https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/logout`);
    logout.searchParams.set('post_logout_redirect_uri', process.env.POST_LOGOUT_REDIRECT_URI || '/');
    res.clearCookie('eam.sid');
    res.redirect(logout.toString());
  });
});

/** Middleware: require a signed-in user for API routes. */
function requireAuth(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  const now = Date.now();
  if (!user.loginAt || now - user.loginAt > SESSION_MAX_MS) {
    securityLog(req, 'session_max_lifetime_reached');
    dropAccount(user.homeAccountId);
    return req.session.destroy(() => res.status(401).json({ error: 'Session expired, please sign in again' }));
  }
  const a = activity.get(user.homeAccountId);
  if (a) a.lastSeen = now;
  else activity.set(user.homeAccountId, { lastSeen: now, loginAt: user.loginAt });
  next();
}

/** Get a Graph access token for the signed-in user (silently, refreshing if needed). */
async function getGraphToken(req) {
  const account = await cca.getTokenCache().getAccountByHomeId(req.session.user.homeAccountId);
  if (!account) {
    const e = new Error('Session expired, please sign in again');
    e.status = 401;
    throw e;
  }
  try {
    const result = await cca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
    return result.accessToken;
  } catch (err) {
    const e = new Error('Session expired, please sign in again');
    e.status = 401;
    e.cause = err;
    throw e;
  }
}

/** App-only Graph token (client credentials), used by the expiry e-mails. MSAL caches it. */
async function getAppToken() {
  const result = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  return result.accessToken;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { router, requireAuth, getGraphToken, getAppToken, SESSION_IDLE_MS };
