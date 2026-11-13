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

app.use(session({
  name: 'eam.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: 60 * 60 * 1000, // 1 hour idle timeout
  },
  // NOTE: default MemoryStore is fine for a single instance. For multiple
  // instances use a shared store (e.g. connect-redis) and a distributed MSAL cache.
}));

app.use(express.json({ limit: '64kb' }));

app.use('/auth', auth.router);
app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// Central error handler — never leak stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  else console.warn(`[${status}] ${req.method} ${req.path}: ${err.code ? err.code + ' - ' : ''}${err.message}`);
  const message = status === 500 ? 'Internal server error' : err.message;
  if (req.path.startsWith('/api')) return res.status(status).json({ error: message, code: err.code });
  res.status(status).send(message);
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log(`Entra Apps Management portal listening on http://localhost:${port}`));
