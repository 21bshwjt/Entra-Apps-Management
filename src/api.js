'use strict';

const express = require('express');
const { X509Certificate, createHash } = require('crypto');
const { requireAuth, getGraphToken } = require('./auth');
const graph = require('./graph');

const router = express.Router();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SECRET_MONTHS = Math.min(Math.max(parseInt(process.env.MAX_SECRET_MONTHS || '24', 10) || 24, 1), 24);

router.use(requireAuth);

// --- CSRF protection for state-changing requests ---------------------------
router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Missing CSRF header' });
  const origin = req.get('Origin');
  if (origin && new URL(origin).host !== req.get('Host')) return res.status(403).json({ error: 'Bad origin' });
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function audit(req, action, details) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    audit: true,
    user: req.session.user.username,
    userOid: req.session.user.oid,
    action,
    ...details,
  }));
}

function bad(res, msg) {
  return res.status(400).json({ error: msg });
}

/**
 * Ownership guard: the app must be in the caller's /me/ownedObjects.
 * Graph would also block non-owners, but this stops admins from using the
 * portal to change apps they don't personally own.
 */
const requireOwnership = wrap(async (req, res, next) => {
  const { id } = req.params;
  if (!GUID.test(id)) return bad(res, 'Invalid application id');
  req.token = await getGraphToken(req);
  const owned = await graph.listOwnedApps(req.token);
  const app = owned.find((a) => a.id === id);
  if (!app) return res.status(403).json({ error: 'You are not an owner of this application' });
  req.app_ = app;
  next();
});

// --- Who am I ---------------------------------------------------------------
router.get('/me', (req, res) => {
  const { name, username, oid } = req.session.user;
  res.json({ name, username, oid, maxSecretMonths: MAX_SECRET_MONTHS });
});

// --- Apps -------------------------------------------------------------------
router.get('/apps', wrap(async (req, res) => {
  const token = await getGraphToken(req);
  const apps = await graph.listOwnedApps(token);
  apps.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  const [spEnabled, deactivated] = await Promise.all([
    spEnabledMap(token, apps.map((a) => a.appId)),
    deactivatedIds(token),
  ]);
  res.json(apps.map((a) => shapeApp(a, spEnabled, deactivated)));
}));

router.get('/apps/:id', requireOwnership, wrap(async (req, res) => {
  const [app, owners, federated, spEnabled, deactivated] = await Promise.all([
    graph.getApp(req.token, req.params.id),
    graph.listOwners(req.token, req.params.id),
    graph.listFederated(req.token, req.params.id),
    spEnabledMap(req.token, [req.app_.appId]),
    deactivatedIds(req.token),
  ]);
  res.json({ ...shapeApp(app, spEnabled, deactivated), owners: owners.map(shapeOwner), federated: federated.map(shapeFederated) });
}));

/** Best effort (beta endpoint): if it fails, no app is reported as deactivated. */
async function deactivatedIds(token) {
  try {
    return await graph.getDeactivatedAppIds(token);
  } catch (e) {
    console.warn(`Could not read app deactivation state: [${e.status}] ${e.message}`);
    return null;
  }
}

/** Best effort: if service principals can't be read, the enabled state is reported as unknown (null). */
async function spEnabledMap(token, appIds) {
  try {
    return await graph.getSpEnabledMap(token, appIds);
  } catch (e) {
    console.warn(`Could not read service principal status: ${e.message}`);
    return null;
  }
}

// --- API permissions (requiredResourceAccess) -------------------------------
const PERM_TYPES = new Set(['Scope', 'Role']);

function shapeCatalog(sp) {
  return {
    appId: sp.appId,
    displayName: sp.displayName,
    scopes: (sp.oauth2PermissionScopes || []).filter((s) => s.isEnabled !== false).map((s) => ({
      id: s.id, value: s.value, displayName: s.adminConsentDisplayName || s.userConsentDisplayName || s.value,
      description: s.adminConsentDescription || '', adminConsentRequired: s.type === 'Admin',
    })).sort((a, b) => (a.value || '').localeCompare(b.value || '')),
    roles: (sp.appRoles || []).filter((r) => r.isEnabled !== false && (r.allowedMemberTypes || []).includes('Application')).map((r) => ({
      id: r.id, value: r.value, displayName: r.displayName || r.value, description: r.description || '', adminConsentRequired: true,
    })).sort((a, b) => (a.value || '').localeCompare(b.value || '')),
  };
}

router.get('/apps/:id/permissions', requireOwnership, wrap(async (req, res) => {
  const rra = await graph.getRequiredResourceAccess(req.token, req.params.id);
  const appSp = await graph.getServicePrincipalByAppId(req.token, req.app_.appId).catch(() => null);

  // Consent status (best effort). App-role assignments are readable with Application.Read*;
  // delegated grants may need more rights, in which case status is reported as unknown.
  let roleAssignments = [];
  let delegatedGrants = null;
  if (appSp) {
    roleAssignments = await graph.listAppRoleAssignments(req.token, appSp.id).catch(() => []);
    delegatedGrants = await graph.listOauth2Grants(req.token, appSp.id).catch(() => null);
  }

  const permissions = [];
  for (const r of rra) {
    const sp = await graph.getServicePrincipalByAppId(req.token, r.resourceAppId).catch(() => null);
    for (const ra of r.resourceAccess || []) {
      let def = null;
      if (sp) {
        def = ra.type === 'Role'
          ? (sp.appRoles || []).find((x) => x.id === ra.id)
          : (sp.oauth2PermissionScopes || []).find((x) => x.id === ra.id);
      }
      const value = def?.value || null;
      let status = 'not_granted';
      if (!appSp) status = 'not_granted';
      else if (ra.type === 'Role') {
        status = sp && roleAssignments.some((a) => a.resourceId === sp.id && a.appRoleId === ra.id) ? 'granted' : 'not_granted';
      } else if (delegatedGrants === null) status = 'unknown';
      else if (sp && value) {
        const grants = delegatedGrants.filter((g) => g.resourceId === sp.id && (g.scope || '').split(' ').includes(value));
        status = grants.some((g) => g.consentType === 'AllPrincipals') ? 'granted' : grants.length ? 'user_consent' : 'not_granted';
      }
      permissions.push({
        resourceAppId: r.resourceAppId,
        resourceName: sp?.displayName || r.resourceAppId,
        id: ra.id,
        type: ra.type,
        value: value || ra.id,
        displayName: ra.type === 'Role' ? def?.displayName : (def?.adminConsentDisplayName || def?.userConsentDisplayName),
        adminConsentRequired: ra.type === 'Role' ? true : def ? def.type === 'Admin' : null,
        status,
      });
    }
  }
  permissions.sort((a, b) => a.resourceName.localeCompare(b.resourceName) || a.type.localeCompare(b.type) || String(a.value).localeCompare(String(b.value)));
  res.json({
    permissions,
    consentUrl: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${req.app_.appId}/isMSAApp~/false`,
  });
}));

router.get('/api-catalog', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 64);
  const token = await getGraphToken(req);
  if (GUID.test(q)) {
    const sp = await graph.getServicePrincipalByAppId(token, q);
    return res.json(sp ? [{ appId: sp.appId, displayName: sp.displayName }] : []);
  }
  if (q.length < 2) return res.json([]);
  const sps = await graph.searchServicePrincipals(token, q);
  res.json(sps.map((s) => ({ appId: s.appId, displayName: s.displayName, type: s.servicePrincipalType })));
}));

router.get('/api-catalog/:appId', wrap(async (req, res) => {
  if (!GUID.test(req.params.appId)) return bad(res, 'Invalid API id');
  const token = await getGraphToken(req);
  const sp = await graph.getServicePrincipalByAppId(token, req.params.appId);
  if (!sp) return res.status(404).json({ error: 'API not found in this tenant' });
  res.json(shapeCatalog(sp));
}));

router.post('/apps/:id/permissions', requireOwnership, wrap(async (req, res) => {
  const resourceAppId = String(req.body?.resourceAppId || '');
  if (!GUID.test(resourceAppId)) return bad(res, 'Invalid API id');
  const wanted = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  if (!wanted.length || wanted.length > 100) return bad(res, 'Select between 1 and 100 permissions');

  const sp = await graph.getServicePrincipalByAppId(req.token, resourceAppId);
  if (!sp) return bad(res, 'API not found in this tenant');
  const catalog = shapeCatalog(sp);
  for (const p of wanted) {
    if (!PERM_TYPES.has(p?.type) || !GUID.test(String(p?.id))) return bad(res, 'Invalid permission');
    const list = p.type === 'Role' ? catalog.roles : catalog.scopes;
    if (!list.some((x) => x.id === p.id)) return bad(res, `Permission ${p.id} is not offered by ${sp.displayName}`);
  }

  const rra = await graph.getRequiredResourceAccess(req.token, req.params.id);
  let entry = rra.find((r) => r.resourceAppId === resourceAppId);
  if (!entry) {
    entry = { resourceAppId, resourceAccess: [] };
    rra.push(entry);
  }
  const added = [];
  for (const p of wanted) {
    if (!entry.resourceAccess.some((a) => a.id === p.id && a.type === p.type)) {
      entry.resourceAccess.push({ id: p.id, type: p.type });
      added.push(p);
    }
  }
  if (!added.length) return bad(res, 'All selected permissions are already configured');
  await graph.setRequiredResourceAccess(req.token, req.params.id, rra);
  audit(req, 'permission.add', {
    appId: req.app_.appId, appName: req.app_.displayName, resource: sp.displayName,
    permissions: added.map((p) => `${p.type}:${(p.type === 'Role' ? catalog.roles : catalog.scopes).find((x) => x.id === p.id)?.value}`),
  });
  res.json({ ok: true, added: added.length });
}));

router.delete('/apps/:id/permissions/:resourceAppId/:type/:permId', requireOwnership, wrap(async (req, res) => {
  const { resourceAppId, type, permId } = req.params;
  if (!GUID.test(resourceAppId) || !GUID.test(permId) || !PERM_TYPES.has(type)) return bad(res, 'Invalid permission');
  const rra = await graph.getRequiredResourceAccess(req.token, req.params.id);
  const entry = rra.find((r) => r.resourceAppId === resourceAppId);
  if (!entry || !entry.resourceAccess.some((a) => a.id === permId && a.type === type)) {
    return res.status(404).json({ error: 'Permission not found' });
  }
  entry.resourceAccess = entry.resourceAccess.filter((a) => !(a.id === permId && a.type === type));
  const updated = rra.filter((r) => r.resourceAccess.length > 0);
  await graph.setRequiredResourceAccess(req.token, req.params.id, updated);
  audit(req, 'permission.remove', { appId: req.app_.appId, appName: req.app_.displayName, resourceAppId, type, permId });
  res.json({ ok: true });
}));

// --- Federated identity credentials ----------------------------------------
const FIC_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/;
const DEFAULT_AUDIENCE = 'api://AzureADTokenExchange';

function validateFederated(body, { requireName }) {
  const out = {};
  if (requireName) {
    const name = String(body?.name || '').trim();
    if (!FIC_NAME.test(name)) {
      throw badReq('Name must be 3-120 characters: letters, numbers, "-" or "_", starting with a letter or number');
    }
    out.name = name;
  }
  const issuer = String(body?.issuer || '').trim();
  let u;
  try { u = new URL(issuer); } catch { throw badReq('Issuer must be a valid URL'); }
  if (u.protocol !== 'https:') throw badReq('Issuer must be an https:// URL');
  if (issuer.length > 600) throw badReq('Issuer is too long (max 600)');
  out.issuer = issuer;

  const subject = String(body?.subject || '').trim();
  if (!subject || subject.length > 600 || /\s/.test(subject)) {
    throw badReq('Subject is required, max 600 characters, no spaces');
  }
  if (subject.includes('*')) throw badReq('Wildcards are not supported in the subject');
  out.subject = subject;

  const audience = String(body?.audience || DEFAULT_AUDIENCE).trim();
  if (audience.length > 600 || /\s/.test(audience)) throw badReq('Invalid audience');
  out.audiences = [audience];

  out.description = String(body?.description || '').trim().slice(0, 600) || null;
  return out;
}

function badReq(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

router.post('/apps/:id/federated', requireOwnership, wrap(async (req, res) => {
  const fic = validateFederated(req.body, { requireName: true });
  const existing = await graph.listFederated(req.token, req.params.id);
  if (existing.length >= 20) return bad(res, 'An application can have at most 20 federated credentials');
  if (existing.some((f) => f.name.toLowerCase() === fic.name.toLowerCase())) return bad(res, 'A federated credential with this name already exists');
  if (existing.some((f) => f.issuer === fic.issuer && f.subject === fic.subject)) {
    return bad(res, 'A federated credential with this issuer and subject already exists');
  }
  const created = await graph.addFederated(req.token, req.params.id, fic);
  audit(req, 'federated.add', { appId: req.app_.appId, appName: req.app_.displayName, ficId: created.id, name: fic.name, issuer: fic.issuer, subject: fic.subject });
  res.json(shapeFederated(created));
}));

router.patch('/apps/:id/federated/:ficId', requireOwnership, wrap(async (req, res) => {
  const { ficId } = req.params;
  if (!GUID.test(ficId)) return bad(res, 'Invalid federated credential id');
  const patch = validateFederated(req.body, { requireName: false });
  const existing = await graph.listFederated(req.token, req.params.id);
  if (!existing.some((f) => f.id === ficId)) return res.status(404).json({ error: 'Federated credential not found' });
  if (existing.some((f) => f.id !== ficId && f.issuer === patch.issuer && f.subject === patch.subject)) {
    return bad(res, 'Another federated credential already uses this issuer and subject');
  }
  await graph.updateFederated(req.token, req.params.id, ficId, patch);
  audit(req, 'federated.update', { appId: req.app_.appId, appName: req.app_.displayName, ficId, issuer: patch.issuer, subject: patch.subject });
  res.json({ ok: true });
}));

router.delete('/apps/:id/federated/:ficId', requireOwnership, wrap(async (req, res) => {
  const { ficId } = req.params;
  if (!GUID.test(ficId)) return bad(res, 'Invalid federated credential id');
  const existing = await graph.listFederated(req.token, req.params.id);
  const fic = existing.find((f) => f.id === ficId);
  if (!fic) return res.status(404).json({ error: 'Federated credential not found' });
  await graph.removeFederated(req.token, req.params.id, ficId);
  audit(req, 'federated.remove', { appId: req.app_.appId, appName: req.app_.displayName, ficId, name: fic.name });
  res.json({ ok: true });
}));

// --- Secrets ----------------------------------------------------------------
router.post('/apps/:id/secrets', requireOwnership, wrap(async (req, res) => {
  const displayName = String(req.body?.displayName || '').trim().slice(0, 100) || 'Created via self-service portal';
  const months = parseInt(req.body?.months, 10);
  if (!Number.isInteger(months) || months < 1 || months > MAX_SECRET_MONTHS) {
    return bad(res, `Expiry must be between 1 and ${MAX_SECRET_MONTHS} months`);
  }
  const end = new Date();
  end.setMonth(end.getMonth() + months);

  const created = await graph.addPassword(req.token, req.params.id, displayName, end.toISOString());

  // Optionally remove the secret being rotated out.
  let removed = null;
  const replaceKeyId = req.body?.replaceKeyId;
  if (replaceKeyId) {
    if (!GUID.test(replaceKeyId)) return bad(res, 'Invalid secret id');
    if ((req.app_.passwordCredentials || []).some((p) => p.keyId === replaceKeyId)) {
      await graph.removePassword(req.token, req.params.id, replaceKeyId);
      removed = replaceKeyId;
    }
  }

  audit(req, 'secret.add', { appId: req.app_.appId, appName: req.app_.displayName, keyId: created.keyId, months, replaced: removed });
  // secretText is returned ONCE and never logged or stored.
  res.json({
    keyId: created.keyId,
    displayName: created.displayName,
    hint: created.hint,
    endDateTime: created.endDateTime,
    secretText: created.secretText,
    removedKeyId: removed,
  });
}));

router.delete('/apps/:id/secrets/:keyId', requireOwnership, wrap(async (req, res) => {
  const { keyId } = req.params;
  if (!GUID.test(keyId)) return bad(res, 'Invalid secret id');
  if (!(req.app_.passwordCredentials || []).some((p) => p.keyId === keyId)) {
    return res.status(404).json({ error: 'Secret not found' });
  }
  await graph.removePassword(req.token, req.params.id, keyId);
  audit(req, 'secret.remove', { appId: req.app_.appId, appName: req.app_.displayName, keyId });
  res.json({ ok: true });
}));

// --- Certificates -----------------------------------------------------------
router.post('/apps/:id/certificates', requireOwnership, wrap(async (req, res) => {
  const b64 = String(req.body?.content || '');
  if (!b64) return bad(res, 'No certificate supplied');

  let der;
  try {
    der = toDer(Buffer.from(b64, 'base64'));
  } catch (e) {
    return bad(res, e.message);
  }

  let cert;
  try {
    cert = new X509Certificate(der);
  } catch {
    return bad(res, 'File is not a valid X.509 certificate (.cer / .crt / .pem)');
  }

  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  if (validTo <= new Date()) return bad(res, 'Certificate has already expired');

  const thumbprintB64 = createHash('sha1').update(der).digest('base64');
  const existing = await graph.getKeyCredentials(req.token, req.params.id);
  if (existing.some((k) => k.customKeyIdentifier === thumbprintB64)) {
    return bad(res, 'This certificate is already on the application');
  }
  if (existing.some((k) => !k.key)) {
    return res.status(409).json({ error: 'Could not read existing certificates safely; aborting to avoid data loss' });
  }

  const cn = (cert.subject.match(/CN=([^\n]+)/) || [])[1] || cert.subject.split('\n')[0];
  const displayName = (String(req.body?.displayName || '').trim() || `CN=${cn}`).slice(0, 100);

  const newKey = {
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: der.toString('base64'),
    customKeyIdentifier: thumbprintB64,
    displayName,
    startDateTime: validFrom.toISOString(),
    endDateTime: validTo.toISOString(),
  };

  await graph.setKeyCredentials(req.token, req.params.id, [...existing, newKey]);
  const thumbprint = createHash('sha1').update(der).digest('hex').toUpperCase();
  audit(req, 'certificate.add', { appId: req.app_.appId, appName: req.app_.displayName, thumbprint, validTo });
  res.json({ ok: true, thumbprint, subject: cert.subject, validFrom, validTo });
}));

router.delete('/apps/:id/certificates/:keyId', requireOwnership, wrap(async (req, res) => {
  const { keyId } = req.params;
  if (!GUID.test(keyId)) return bad(res, 'Invalid certificate id');
  const existing = await graph.getKeyCredentials(req.token, req.params.id);
  if (!existing.some((k) => k.keyId === keyId)) return res.status(404).json({ error: 'Certificate not found' });
  const remaining = existing.filter((k) => k.keyId !== keyId);
  if (remaining.some((k) => !k.key)) {
    return res.status(409).json({ error: 'Could not read existing certificates safely; aborting to avoid data loss' });
  }
  await graph.setKeyCredentials(req.token, req.params.id, remaining);
  audit(req, 'certificate.remove', { appId: req.app_.appId, appName: req.app_.displayName, keyId });
  res.json({ ok: true });
}));

// --- Owners -----------------------------------------------------------------
router.post('/apps/:id/owners', requireOwnership, wrap(async (req, res) => {
  const userId = String(req.body?.userId || '');
  if (!GUID.test(userId)) return bad(res, 'Invalid user id');
  const owners = await graph.listOwners(req.token, req.params.id);
  if (owners.some((o) => o.id === userId)) return bad(res, 'User is already an owner');
  await graph.addOwner(req.token, req.params.id, userId);
  audit(req, 'owner.add', { appId: req.app_.appId, appName: req.app_.displayName, ownerId: userId });
  res.json({ ok: true });
}));

router.delete('/apps/:id/owners/:ownerId', requireOwnership, wrap(async (req, res) => {
  const { ownerId } = req.params;
  if (!GUID.test(ownerId)) return bad(res, 'Invalid owner id');
  const owners = await graph.listOwners(req.token, req.params.id);
  if (!owners.some((o) => o.id === ownerId)) return res.status(404).json({ error: 'Owner not found' });
  if (owners.length <= 1) return bad(res, 'Cannot remove the last owner of an application');
  await graph.removeOwner(req.token, req.params.id, ownerId);
  audit(req, 'owner.remove', { appId: req.app_.appId, appName: req.app_.displayName, ownerId });
  res.json({ ok: true, removedSelf: ownerId === req.session.user.oid });
}));

router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  if (/[\\"]/.test(q)) return bad(res, 'Invalid characters in search');
  const token = await getGraphToken(req);
  const users = await graph.searchUsers(token, q.slice(0, 64));
  res.json(users.map(shapeOwner));
}));

// --- Helpers ----------------------------------------------------------------
function toDer(buf) {
  const text = buf.toString('utf8');
  if (text.includes('-----BEGIN')) {
    if (/PRIVATE KEY-----/.test(text)) {
      throw new Error('This file contains a PRIVATE KEY. Upload only the public certificate (.cer/.crt/.pem).');
    }
    const m = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!m) throw new Error('No CERTIFICATE block found in PEM file');
    return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  }
  // PFX / PKCS#12 files would contain private keys; X509Certificate will reject them anyway.
  return buf;
}

function shapeApp(a, spEnabled, deactivatedSet) {
  const deactivated = deactivatedSet ? deactivatedSet.has(a.id) : null;
  // true / false from the service principal; null when there is no SP in this tenant or it couldn't be read.
  const signInEnabled = spEnabled?.has(a.appId) ? spEnabled.get(a.appId) !== false : null;
  const disabledByMicrosoft = !!a.disabledByMicrosoftStatus && a.disabledByMicrosoftStatus !== 'NotDisabled'
    ? a.disabledByMicrosoftStatus : null;
  return {
    id: a.id,
    appId: a.appId,
    displayName: a.displayName,
    createdDateTime: a.createdDateTime,
    signInAudience: a.signInAudience,
    signInEnabled,
    disabledByMicrosoft,
    deactivated,
    disabled: deactivated === true || signInEnabled === false || !!disabledByMicrosoft,
    secrets: (a.passwordCredentials || []).map((p) => ({
      keyId: p.keyId, displayName: p.displayName, hint: p.hint,
      startDateTime: p.startDateTime, endDateTime: p.endDateTime,
    })),
    certificates: (a.keyCredentials || []).map((k) => ({
      keyId: k.keyId, displayName: k.displayName, type: k.type, usage: k.usage,
      thumbprint: k.customKeyIdentifier ? Buffer.from(k.customKeyIdentifier, 'base64').toString('hex').toUpperCase() : null,
      startDateTime: k.startDateTime, endDateTime: k.endDateTime,
    })),
  };
}

function shapeFederated(f) {
  return {
    id: f.id,
    name: f.name,
    issuer: f.issuer,
    subject: f.subject,
    audiences: f.audiences || [],
    description: f.description || null,
  };
}

function shapeOwner(o) {
  return {
    id: o.id,
    displayName: o.displayName,
    userPrincipalName: o.userPrincipalName || null,
    mail: o.mail || null,
    type: (o['@odata.type'] || '#microsoft.graph.user').replace('#microsoft.graph.', ''),
  };
}

module.exports = router;
