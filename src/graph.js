'use strict';

const GRAPH = 'https://graph.microsoft.com/v1.0';

class GraphError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(token, method, path, body, extraHeaders = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.error?.message || `Graph request failed (${res.status})`;
    // Graph returns 403 Authorization_RequestDenied when the user lacks rights on the object.
    throw new GraphError(res.status, msg, data?.error?.code);
  }
  return data;
}

async function getAll(token, path, headers) {
  const items = [];
  let next = path;
  while (next) {
    const page = await call(token, 'GET', next, undefined, headers);
    items.push(...(page.value || []));
    next = page['@odata.nextLink'];
  }
  return items;
}

const spCache = new Map();

const APP_FIELDS = 'id,appId,displayName,createdDateTime,signInAudience,passwordCredentials,keyCredentials';

module.exports = {
  GraphError,

  /** Apps the signed-in user owns. */
  listOwnedApps: (t) =>
    getAll(t, `/me/ownedObjects/microsoft.graph.application?$select=${APP_FIELDS}&$top=999`),

  getApp: (t, id) => call(t, 'GET', `/applications/${encodeURIComponent(id)}?$select=${APP_FIELDS}`),

  /** Returns keyCredentials INCLUDING the raw `key` (only returned on single-object $select). */
  getKeyCredentials: async (t, id) =>
    (await call(t, 'GET', `/applications/${encodeURIComponent(id)}?$select=keyCredentials`)).keyCredentials || [],

  setKeyCredentials: (t, id, keyCredentials) =>
    call(t, 'PATCH', `/applications/${encodeURIComponent(id)}`, { keyCredentials }),

  addPassword: (t, id, displayName, endDateTime) =>
    call(t, 'POST', `/applications/${encodeURIComponent(id)}/addPassword`, {
      passwordCredential: { displayName, endDateTime },
    }),

  removePassword: (t, id, keyId) =>
    call(t, 'POST', `/applications/${encodeURIComponent(id)}/removePassword`, { keyId }),

  listOwners: (t, id) =>
    getAll(t, `/applications/${encodeURIComponent(id)}/owners?$select=id,displayName,userPrincipalName,mail,appId`),

  addOwner: (t, id, userId) =>
    call(t, 'POST', `/applications/${encodeURIComponent(id)}/owners/$ref`, {
      '@odata.id': `${GRAPH}/directoryObjects/${userId}`,
    }),

  removeOwner: (t, id, ownerId) =>
    call(t, 'DELETE', `/applications/${encodeURIComponent(id)}/owners/${encodeURIComponent(ownerId)}/$ref`),

  /**
   * Find users by name / UPN / mail prefix. Works with User.ReadBasic.All.
   * If the query is an object id or a full UPN, it is looked up directly first.
   */
  searchUsers: async (t, q) => {
    const select = '$select=id,displayName,userPrincipalName,mail';
    const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    if (isGuid || /^[^\s@]+@[^\s@]+$/.test(q)) {
      try {
        const u = await call(t, 'GET', `/users/${encodeURIComponent(q)}?${select}`);
        if (u?.id) return [u];
      } catch (e) {
        if (e.status !== 404 && e.status !== 400) throw e;
      }
    }
    const s = q.replace(/'/g, "''");
    const filter = encodeURIComponent(
      `startswith(displayName,'${s}') or startswith(userPrincipalName,'${s}') or startswith(mail,'${s}')`,
    );
    const r = await call(t, 'GET', `/users?$filter=${filter}&${select}&$top=15&$count=true`, undefined, {
      ConsistencyLevel: 'eventual',
    });
    return r.value || [];
  },

  // --- API permissions (requiredResourceAccess) ---
  getRequiredResourceAccess: async (t, id) =>
    (await call(t, 'GET', `/applications/${encodeURIComponent(id)}?$select=requiredResourceAccess`)).requiredResourceAccess || [],

  setRequiredResourceAccess: (t, id, requiredResourceAccess) =>
    call(t, 'PATCH', `/applications/${encodeURIComponent(id)}`, { requiredResourceAccess }),

  /** Service principal for an appId in this tenant, or null if not present. Cached (scopes lists are large). */
  getServicePrincipalByAppId: async (t, appId) => {
    const hit = spCache.get(appId);
    if (hit && hit.exp > Date.now()) return hit.sp;
    let sp = null;
    try {
      sp = await call(t, 'GET',
        `/servicePrincipals(appId='${encodeURIComponent(appId)}')?$select=id,appId,displayName,oauth2PermissionScopes,appRoles`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    spCache.set(appId, { sp, exp: Date.now() + 10 * 60 * 1000 });
    return sp;
  },

  searchServicePrincipals: async (t, q) => {
    const s = q.replace(/'/g, "''");
    const filter = encodeURIComponent(`startswith(displayName,'${s}')`);
    const r = await call(t, 'GET',
      `/servicePrincipals?$filter=${filter}&$select=id,appId,displayName,servicePrincipalType&$top=25&$count=true`,
      undefined, { ConsistencyLevel: 'eventual' });
    return r.value || [];
  },

  listAppRoleAssignments: (t, spId) =>
    getAll(t, `/servicePrincipals/${encodeURIComponent(spId)}/appRoleAssignments`),

  listOauth2Grants: (t, spId) =>
    getAll(t, `/servicePrincipals/${encodeURIComponent(spId)}/oauth2PermissionGrants`),

  // --- Federated identity credentials (workload identity federation) ---
  listFederated: (t, id) =>
    getAll(t, `/applications/${encodeURIComponent(id)}/federatedIdentityCredentials`),

  addFederated: (t, id, fic) =>
    call(t, 'POST', `/applications/${encodeURIComponent(id)}/federatedIdentityCredentials`, fic),

  updateFederated: (t, id, ficId, patch) =>
    call(t, 'PATCH', `/applications/${encodeURIComponent(id)}/federatedIdentityCredentials/${encodeURIComponent(ficId)}`, patch),

  removeFederated: (t, id, ficId) =>
    call(t, 'DELETE', `/applications/${encodeURIComponent(id)}/federatedIdentityCredentials/${encodeURIComponent(ficId)}`),
};
