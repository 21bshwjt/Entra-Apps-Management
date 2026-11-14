'use strict';

/**
 * Shared security helpers: high-risk permission list, security event log,
 * rate limiting, federated issuer allowlist and certificate strength checks.
 */

const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const EXCHANGE_APP_ID = '00000002-0000-0ff1-ce00-000000000000';

/** Permissions that give broad control over the tenant, keyed by the API's appId. */
const HIGH_RISK = {
  [GRAPH_APP_ID]: new Set([
    'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All',
    'Directory.ReadWrite.All', 'Directory.AccessAsUser.All',
    'RoleManagement.ReadWrite.Directory', 'RoleAssignmentSchedule.ReadWrite.Directory',
    'RoleEligibilitySchedule.ReadWrite.Directory', 'PrivilegedAccess.ReadWrite.AzureAD',
    'User.ReadWrite.All', 'User.ManageIdentities.All', 'UserAuthenticationMethod.ReadWrite.All',
    'Group.ReadWrite.All', 'GroupMember.ReadWrite.All',
    'Policy.ReadWrite.ConditionalAccess', 'Policy.ReadWrite.AuthenticationMethod', 'Policy.ReadWrite.PermissionGrant',
    'Domain.ReadWrite.All', 'Organization.ReadWrite.All',
    'Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite',
    'Files.ReadWrite.All', 'Sites.ReadWrite.All', 'Sites.FullControl.All',
  ]),
  [EXCHANGE_APP_ID]: new Set(['full_access_as_app', 'Exchange.ManageAsApp', 'Mail.ReadWrite', 'Mail.Send']),
};

const isHighRisk = (resourceAppId, value) => !!value && !!HIGH_RISK[resourceAppId]?.has(value);

/** One JSON line per security event (denials, blocks, rate limits). Goes to stderr. */
function securityLog(req, event, details = {}) {
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    security: true,
    event,
    user: req?.session?.user?.username || null,
    userOid: req?.session?.user?.oid || null,
    ip: req?.ip || null,
    method: req?.method,
    path: req?.originalUrl?.split('?')[0],
    ...details,
  }));
}

/**
 * True when a request was sent by the portal's own page.
 * - Modern browsers send Sec-Fetch-Site, which pages cannot forge: only "same-origin" passes.
 * - Otherwise the Origin header must match the Host. Browsers send "Origin: null" on form
 *   POSTs under Referrer-Policy: no-referrer, so "null" alone is not trusted.
 * - Requests with neither header (curl, scripts) cannot be cross-site browser requests.
 */
function isSameOrigin(req) {
  const site = req.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const origin = req.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('Host'); } catch { return false; }
}

/** Simple fixed-window rate limiter kept in memory (fine for a single instance). */
function rateLimit({ name, windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(k, e);
    }
    e.count++;
    if (e.count <= max) return next();
    const retry = Math.ceil((e.reset - now) / 1000);
    if (e.count === max + 1) securityLog(req, 'rate_limited', { limit: name });
    res.setHeader('Retry-After', String(retry));
    return res.status(429).json({ error: `Too many requests. Try again in ${retry} seconds.` });
  };
}

// ---------- federated credential issuer allowlist ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Patterns are comma separated. "*" at the end matches the rest of the URL;
 * "*" anywhere else matches one host label or path segment (letters, digits, "-").
 * A single "*" allows any https issuer.
 */
function issuerAllowlist(raw) {
  const tenant = process.env.TENANT_ID || '';
  const defaults = [
    'https://token.actions.githubusercontent.com',
    'https://vstoken.dev.azure.com/*',
    `https://login.microsoftonline.com/${tenant}/v2.0`,
    'https://*.oic.prod-aks.azure.com/*',
  ];
  const patterns = (raw ? raw.split(',') : defaults).map((s) => s.trim()).filter(Boolean);
  if (patterns.includes('*')) return { patterns, allows: () => true };
  const regexes = patterns.map((p) => {
    const trailing = p.endsWith('*');
    const body = trailing ? p.slice(0, -1) : p;
    const re = body.split('*').map(escapeRe).join('[A-Za-z0-9-]+');
    return new RegExp(`^${re}${trailing ? '[^\\s?#]*' : '/?'}$`, 'i');
  });
  return { patterns, allows: (issuer) => regexes.some((r) => r.test(issuer)) };
}

// ---------- certificate strength ----------
const WEAK_SIG_OIDS = [
  ['06092a864886f70d010105', 'SHA-1'], // sha1WithRSAEncryption
  ['06052b0e03021d', 'SHA-1'], // sha1WithRSA (OIW)
  ['06072a8648ce3d0401', 'SHA-1'], // ecdsa-with-SHA1
  ['06092a864886f70d010104', 'MD5'], // md5WithRSAEncryption
].map(([hex, name]) => [Buffer.from(hex, 'hex'), name]);
const STRONG_CURVES = new Set(['prime256v1', 'secp384r1', 'secp521r1']);

/** Returns a reason string if the certificate is too weak, otherwise null. */
function certWeakness(cert, der) {
  const key = cert.publicKey;
  const type = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails || {};
  if (type === 'rsa' || type === 'rsa-pss') {
    if ((d.modulusLength || 0) < 2048) return `The RSA key is ${d.modulusLength} bits; at least 2048 bits is required.`;
  } else if (type === 'ec') {
    if (!STRONG_CURVES.has(d.namedCurve)) return `The elliptic curve ${d.namedCurve} is too weak; use P-256 or stronger.`;
  } else {
    return `Unsupported key type "${type}"; use an RSA (2048+ bits) certificate.`;
  }
  const weakSig = WEAK_SIG_OIDS.find(([oid]) => der.includes(oid));
  if (weakSig) return `The certificate is signed with ${weakSig[1]}; use SHA-256 or stronger.`;
  return null;
}

module.exports = { HIGH_RISK, isHighRisk, securityLog, isSameOrigin, rateLimit, issuerAllowlist, certWeakness };
