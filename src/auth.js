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
      req.session.user = {
        homeAccountId: result.account.homeAccountId,
        oid: result.account.idTokenClaims?.oid,
        name: result.account.name,
        username: result.account.username,
      };
      req.session.save((e) => (e ? next(e) : res.redirect('/')));
    });
  } catch (err) {
    next(err);
  }
});

router.get('/signout', async (req, res) => {
  const homeId = req.session?.user?.homeAccountId;
  if (homeId) {
    try {
      const account = await cca.getTokenCache().getAccountByHomeId(homeId);
      if (account) await cca.getTokenCache().removeAccount(account);
    } catch { /* ignore */ }
  }
  req.session.destroy(() => {
    const logout = new URL(`https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/logout`);
    logout.searchParams.set('post_logout_redirect_uri', process.env.POST_LOGOUT_REDIRECT_URI || '/');
    res.clearCookie('eam.sid');
    res.redirect(logout.toString());
  });
});

/** Middleware: require a signed-in user for API routes. */
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not signed in' });
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

module.exports = { router, requireAuth, getGraphToken, getAppToken };
