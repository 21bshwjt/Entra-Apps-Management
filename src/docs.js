'use strict';

/**
 * Swagger UI for the portal's REST API, at /api-docs. SuperAdmins only.
 * Assets come from the swagger-ui-dist package and are served locally (no CDN).
 * "Try it out" calls /api with the viewer's own session, so it can do exactly what
 * the viewer could do in the portal, and every change is audited as usual.
 */

const path = require('path');
const express = require('express');
const swaggerDist = require('swagger-ui-dist').getAbsoluteFSPath();
const { securityLog } = require('./security');
const { buildSpec } = require('./openapi');

const router = express.Router();
const DOCS_DIR = path.join(__dirname, 'docs');
const MAX_SECRET_MONTHS = Math.min(Math.max(parseInt(process.env.MAX_SECRET_MONTHS || '24', 10) || 24, 1), 24);

/** Only these files are served: name -> folder. */
const FILES = {
  'swagger-ui.css': swaggerDist,
  'swagger-ui-bundle.js': swaggerDist,
  'favicon-32x32.png': swaggerDist,
  'docs.css': DOCS_DIR,
  'init.js': DOCS_DIR,
};

// Same as the portal's policy, except Swagger UI needs inline styles (scripts stay 'self' only).
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self' data:", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

router.use((req, res, next) => {
  const user = req.session?.user;
  if (!user?.role) {
    // Not signed in (or a session from before roles existed): send them to the portal to sign in.
    return req.path === '/' ? res.redirect('/') : res.status(401).json({ error: 'Not signed in' });
  }
  if (user.role !== 'superadmin') {
    securityLog(req, 'api_docs_not_allowed');
    return res.status(403).type('text/plain').send('The API docs are available to SuperAdmins only.');
  }
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-cache');
  next();
});

router.get('/', (req, res) => res.sendFile(path.join(DOCS_DIR, 'index.html')));

router.get('/openapi.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildSpec({ maxSecretMonths: MAX_SECRET_MONTHS }));
});

router.get('/:file', (req, res, next) => {
  const dir = Object.hasOwn(FILES, req.params.file) ? FILES[req.params.file] : null;
  if (!dir) return next();
  res.sendFile(path.join(dir, req.params.file));
});

module.exports = router;
