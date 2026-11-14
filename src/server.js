'use strict';

require('dotenv').config();

for (const k of ['TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET']) {
  if (!process.env[k]) {
    console.error(`Missing required environment variable ${k}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const auth = require('./auth');
const api = require('./api');
const { rateLimit } = require('./security');

const app = express();
const isHttps = process.env.REDIRECT_URI.startsWith('https://');

app.set('trust proxy', 1); // honour X-Forwarded-Proto behind App Service / reverse proxies
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'", 'https://login.microsoftonline.com'],
      frameAncestors: ["'none'"],
    },
  },
}));

const sessionStore = new session.MemoryStore();
// MemoryStore never removes expired sessions on its own; all() drops them as a side effect.
setInterval(() => sessionStore.all(() => {}), 15 * 60 * 1000).unref();

app.use(session({
  name: 'eam.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: auth.SESSION_IDLE_MS, // 1 hour idle timeout (absolute limit: SESSION_MAX_HOURS)
  },
  // NOTE: default MemoryStore is fine for a single instance. For multiple
  // instances use a shared store (e.g. connect-redis) and a distributed MSAL cache.
}));

app.use(express.json({ limit: '64kb' }));

// API and sign-in responses must never be cached (they can contain secrets or tokens in redirects).
app.use(['/api', '/auth'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Sign-in endpoints: limit per client IP.
app.use('/auth', rateLimit({ name: 'auth', windowMs: 5 * 60 * 1000, max: 60, key: (req) => req.ip }));

app.use('/auth', auth.router);
app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  // Always revalidate so a browser never runs an old app.js after an update.
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Central error handler — never leak stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  else console.warn(`[${status}] ${req.method} ${req.path}: ${err.code ? err.code + ' - ' : ''}${err.message}`);
  const message = status === 500 ? 'Internal server error' : err.message;
  if (req.path.startsWith('/api')) return res.status(status).json({ error: message, code: err.code });
  res.status(status).type('text/plain').send(message);
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`Entra Apps Management portal listening on http://localhost:${port}`);
  require('./notify').start();
});
