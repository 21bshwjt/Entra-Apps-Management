'use strict';

const $ = (s) => document.querySelector(s);
const state = { me: null, apps: [], current: null };
const EXPIRING_DAYS = 30;

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'fetch',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/api/me') { showSignedOut(); throw new Error('Signed out'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : String(c));
  return n;
}
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
function status(end) {
  if (!end) return { label: 'No expiry', cls: 'ok' };
  const days = Math.floor((new Date(end) - Date.now()) / 86400000);
  if (days < 0) return { label: 'Expired', cls: 'bad' };
  if (days <= EXPIRING_DAYS) return { label: `Expires in ${days}d`, cls: 'warn' };
  return { label: 'Valid', cls: 'ok' };
}
const badge = (s) => el('span', { class: `badge ${s.cls}` }, s.label);
function disabledReason(app) {
  if (app.deactivated) return '⛔ This app registration is deactivated (App registrations → Overview → State: Deactivated). '
    + 'No new tokens can be issued for it. You can still manage its credentials here, but it can only be re-enabled by an Entra administrator.';
  if (app.disabledByMicrosoft) return `⛔ Disabled by Microsoft (${app.disabledByMicrosoft}). The app can't sign in or get tokens. Contact your Entra admin.`;
  return '⛔ Sign-in is disabled for this app (Enterprise applications → Properties → "Enabled for users to sign-in?" = No). '
    + 'It can\'t sign in or get tokens until an admin re-enables it. You can still manage its credentials here.';
}
function worst(app) {
  const all = [...app.secrets, ...app.certificates].map((c) => status(c.endDateTime).cls);
  return all.includes('bad') ? 'bad' : all.includes('warn') ? 'warn' : all.length ? 'ok' : 'none';
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}

function confirmAction(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const d = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel;
    const ok = () => { cleanup(); d.close(); resolve(true); };
    const cancel = () => { cleanup(); resolve(false); };
    function cleanup() { $('#confirmOk').removeEventListener('click', ok); d.removeEventListener('close', cancel); }
    $('#confirmOk').addEventListener('click', ok);
    d.addEventListener('close', cancel, { once: true });
    d.showModal();
  });
}

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { if (e.message !== 'Signed out') toast(e.message, 'bad'); } finally { if (btn) btn.disabled = false; }
}

// ---------- views ----------
function showSignedOut() {
  $('#signedIn').classList.add('hidden');
  $('#userBox').classList.add('hidden');
  $('#signedOut').classList.remove('hidden');
}

async function init() {
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    return showSignedOut();
  }
  $('#userName').textContent = state.me.name || state.me.username;
  $('#userBox').classList.remove('hidden');
  $('#signedIn').classList.remove('hidden');

  const sel = $('#secretMonths');
  for (const m of [1, 3, 6, 12, 18, 24].filter((m) => m <= state.me.maxSecretMonths)) {
    sel.append(el('option', { value: m, ...(m === 6 ? { selected: '' } : {}) }, m === 1 ? '1 month' : `${m} months`));
  }
  await loadApps();
}

async function loadApps() {
  $('#appList').replaceChildren(el('li', { class: 'muted pad' }, 'Loading…'));
  await busy(null, async () => {
    state.apps = await api('GET', '/api/apps');
    renderAppList();
  });
}

function renderAppList() {
  const q = $('#appFilter').value.trim().toLowerCase();
  const apps = state.apps.filter((a) => !q || a.displayName?.toLowerCase().includes(q) || a.appId.includes(q));
  $('#appCount').textContent = `(${state.apps.length})`;
  const list = $('#appList');
  const none = !state.apps.length;
  $('#appFilter').classList.toggle('hidden', none);
  if (none) {
    list.replaceChildren(el('li', { class: 'muted pad' }, 'You do not own any app registrations.'));
    $('#emptyState').replaceChildren(
      el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '📭'),
      el('h3', {}, 'You are not an owner of any application'),
      el('p', {}, 'This portal only shows app registrations where you are listed as an owner.'),
      el('p', {}, 'If you should own an app, ask one of its current owners or your Entra ID administrator to add you as an owner, then refresh this page.'));
    return;
  }
  if (!state.current) $('#emptyState').textContent = 'Select an application to manage it.';
  if (!apps.length) {
    list.replaceChildren(el('li', { class: 'muted pad' }, 'No applications match your filter.'));
    return;
  }
  list.replaceChildren(...apps.map((a) => el('li', {},
    el('button', {
      class: `app-item ${state.current?.id === a.id ? 'active' : ''}`,
      type: 'button',
      onclick: () => selectApp(a.id),
    },
    a.disabled
      ? el('span', { class: 'disabled-icon', title: disabledReason(a), 'aria-label': 'Disabled' }, '⛔')
      : el('span', { class: `dot ${worst(a)}`, title: 'Credential health' }),
    el('span', { class: 'app-text' },
      el('span', { class: 'app-name' }, a.displayName || '(no name)'),
      el('span', { class: 'app-id' }, a.appId)),
    ))));
}

async function selectApp(id, reloadPermissions = false) {
  await busy(null, async () => {
    const switched = state.current?.id !== id;
    state.current = await api('GET', `/api/apps/${id}`);
    if (switched || reloadPermissions) loadPermissions();
    const i = state.apps.findIndex((a) => a.id === id);
    if (i >= 0) {
      const { secrets, certificates, signInEnabled, disabledByMicrosoft, deactivated, disabled } = state.current;
      state.apps[i] = { ...state.apps[i], secrets, certificates, signInEnabled, disabledByMicrosoft, deactivated, disabled };
    }
    renderAppList();
    renderDetail();
  });
}

function renderDetail() {
  const a = state.current;
  $('#emptyState').classList.add('hidden');
  $('#appDetail').classList.remove('hidden');
  const privileged = Array.isArray(a.privileged) && a.privileged.length > 0;
  // Built with el(), which skips null children (the native replaceChildren would print "null").
  $('#dName').replaceChildren(el('span', {}, a.displayName || '(no name)',
    a.disabled ? el('span', { class: 'badge bad' }, 'Disabled') : null,
    privileged ? el('span', { class: 'badge warn' }, 'High-risk permissions') : null));
  $('#dDisabledNote').textContent = a.disabled ? disabledReason(a) : '';
  $('#dDisabledNote').classList.toggle('hidden', !a.disabled);
  $('#dPrivNote').textContent = privileged
    ? `⚠️ This app holds high-risk permissions (${a.privileged.join(', ')}). `
      + (a.privilegedMode === 'warn'
        ? 'New secrets, certificates, federated credentials and owners are allowed but logged for review.'
        : 'Adding secrets, certificates, federated credentials or owners is blocked here; ask an Entra administrator. You can still delete them.')
    : '';
  $('#dPrivNote').classList.toggle('hidden', !privileged);
  $('#dAppId').textContent = a.appId;
  $('#dObjId').textContent = a.id;
  // One-way: shown only while the app is not deactivated; there is no "enable" button.
  $('#disableAppBtn').classList.toggle('hidden', a.deactivated === true);

  // secrets
  const sRows = a.secrets
    .sort((x, y) => new Date(y.endDateTime) - new Date(x.endDateTime))
    .map((s) => el('tr', {},
      el('td', {}, s.displayName || '—'),
      el('td', {}, el('code', {}, s.hint ? `${s.hint}…` : '—')),
      el('td', {}, fmtDate(s.endDateTime)),
      el('td', {}, badge(status(s.endDateTime))),
      el('td', { class: 'right' }, el('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: (e) => deleteSecret(s, e.currentTarget) }, 'Delete'))));
  $('#secretRows').replaceChildren(...(sRows.length ? sRows : [emptyRow(5, 'No client secrets.')]));

  // certificates
  const cRows = a.certificates
    .sort((x, y) => new Date(y.endDateTime) - new Date(x.endDateTime))
    .map((c) => el('tr', {},
      el('td', {}, c.displayName || '—'),
      el('td', {}, el('code', { class: 'thumb' }, c.thumbprint || '—')),
      el('td', {}, fmtDate(c.endDateTime)),
      el('td', {}, badge(status(c.endDateTime))),
      el('td', { class: 'right' }, el('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: (e) => deleteCert(c, e.currentTarget) }, 'Delete'))));
  $('#certRows').replaceChildren(...(cRows.length ? cRows : [emptyRow(5, 'No certificates.')]));

  // federated credentials
  const fRows = (a.federated || [])
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((f) => el('tr', {},
      el('td', {}, el('div', { class: 'app-name' }, f.name), f.description ? el('div', { class: 'muted small' }, f.description) : null),
      el('td', {}, el('code', { class: 'wrap' }, f.issuer)),
      el('td', {}, el('code', { class: 'wrap' }, f.subject)),
      el('td', {}, el('code', { class: 'wrap' }, f.audiences.join(', '))),
      el('td', { class: 'right nowrap' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openFicDialog(f) }, 'Edit'),
        el('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: (e) => deleteFic(f, e.currentTarget) }, 'Delete'))));
  $('#ficRows').replaceChildren(...(fRows.length ? fRows : [emptyRow(5, 'No federated credentials.')]));

  // owners
  const oRows = a.owners.map((o) => el('tr', {},
    el('td', {}, o.displayName || '—', o.id === state.me.oid ? el('span', { class: 'badge you' }, 'You') : null),
    el('td', {}, o.userPrincipalName || o.mail || '—'),
    el('td', {}, o.type),
    el('td', { class: 'right' }, el('button', {
      class: 'btn btn-danger-ghost', type: 'button',
      ...(a.owners.length <= 1 ? { disabled: '', title: 'An app must keep at least one owner' } : {}),
      onclick: (e) => removeOwner(o, e.currentTarget),
    }, 'Remove'))));
  $('#ownerRows').replaceChildren(...(oRows.length ? oRows : [emptyRow(4, 'No owners.')]));
}
const emptyRow = (cols, text) => el('tr', {}, el('td', { colspan: cols, class: 'muted center' }, text));

// ---------- secrets ----------
function openSecretDialog() {
  const sel = $('#secretReplace');
  sel.replaceChildren(el('option', { value: '' }, '— Keep all existing secrets —'),
    ...state.current.secrets.map((s) => el('option', { value: s.keyId },
      `${s.displayName || '(no description)'} · ${s.hint || ''}… · expires ${fmtDate(s.endDateTime)}`)));
  $('#secretName').value = '';
  $('#secretDialog').showModal();
}

async function createSecret(ev) {
  ev.preventDefault();
  const btn = ev.submitter;
  const replaceKeyId = $('#secretReplace').value || undefined;
  if (replaceKeyId && !(await confirmAction('Replace secret?',
    'The selected existing secret will be deleted immediately after the new one is created. Anything still using it will stop working.', 'Create & replace'))) return;
  await busy(btn, async () => {
    const r = await api('POST', `/api/apps/${state.current.id}/secrets`, {
      displayName: $('#secretName').value,
      months: Number($('#secretMonths').value),
      replaceKeyId,
    });
    $('#secretDialog').close();
    $('#secretValue').textContent = r.secretText;
    $('#secretKeyId').textContent = r.keyId;
    $('#secretExpires').textContent = fmtDate(r.endDateTime);
    $('#revealDialog').showModal();
    await selectApp(state.current.id);
  });
}

async function deleteSecret(s, btn) {
  if (!(await confirmAction('Delete client secret?', `"${s.displayName || s.hint}" will be deleted. Applications using it will fail to authenticate.`, 'Delete'))) return;
  await busy(btn, async () => {
    await api('DELETE', `/api/apps/${state.current.id}/secrets/${s.keyId}`);
    toast('Secret deleted');
    await selectApp(state.current.id);
  });
}

// ---------- disable app (one way) ----------
async function disableApp(btn) {
  const a = state.current;
  if (!(await confirmAction('Disable this app?',
    `"${a.displayName}" will be deactivated. No new tokens can be issued, so anything that signs in as this app will stop working `
    + 'once its current tokens expire. You CANNOT re-enable it from this portal; only an Entra administrator can.',
    'Disable app'))) return;
  await busy(btn, async () => {
    const r = await api('POST', `/api/apps/${a.id}/disable`, {});
    toast(r.alreadyDisabled ? 'App was already disabled' : 'App disabled');
    await selectApp(a.id);
  });
}

// ---------- certificates ----------
async function uploadCert(ev) {
  ev.preventDefault();
  const file = $('#certFile').files[0];
  if (!file) return;
  if (file.size > 32 * 1024) return toast('Certificate file is too large', 'bad');
  await busy(ev.submitter, async () => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    const r = await api('POST', `/api/apps/${state.current.id}/certificates`, {
      content: btoa(bin),
      displayName: $('#certName').value,
    });
    toast(`Certificate ${r.thumbprint.slice(0, 8)}… uploaded (valid to ${fmtDate(r.validTo)})`);
    $('#certForm').reset();
    $('#certFileLabel').textContent = 'Choose public certificate (.cer, .crt, .pem)';
    await selectApp(state.current.id);
  });
}

async function deleteCert(c, btn) {
  if (!(await confirmAction('Delete certificate?', `Certificate ${c.thumbprint || c.displayName} will be removed. Clients authenticating with it will fail.`, 'Delete'))) return;
  await busy(btn, async () => {
    await api('DELETE', `/api/apps/${state.current.id}/certificates/${c.keyId}`);
    toast('Certificate deleted');
    await selectApp(state.current.id);
  });
}

// ---------- API permissions ----------
const perm = { list: [], catalog: null, selected: new Set() };
const STATUS = {
  granted: { label: 'Granted for tenant', cls: 'ok' },
  user_consent: { label: 'User consent only', cls: 'warn' },
  not_granted: { label: 'Not granted', cls: 'warn' },
  unknown: { label: 'Unknown', cls: 'none' },
};

async function loadPermissions() {
  const appId = state.current.id;
  $('#permRows').replaceChildren(emptyRow(5, 'Loading…'));
  try {
    const r = await api('GET', `/api/apps/${appId}/permissions`);
    if (state.current?.id !== appId) return; // user switched app meanwhile
    perm.list = r.permissions;
    $('#consentLink').href = r.consentUrl;
    renderPermissions();
  } catch (e) {
    if (state.current?.id === appId) $('#permRows').replaceChildren(el('tr', {}, el('td', { colspan: 5, class: 'error center' }, e.message)));
  }
}

function renderPermissions() {
  if (!perm.list.length) {
    $('#permRows').replaceChildren(emptyRow(5, 'No API permissions configured.'));
    return;
  }
  const rows = [];
  let lastRes = null;
  for (const p of perm.list) {
    if (p.resourceAppId !== lastRes) {
      lastRes = p.resourceAppId;
      rows.push(el('tr', { class: 'group' }, el('td', { colspan: 5 }, p.resourceName,
        el('span', { class: 'muted small' }, ` (${perm.list.filter((x) => x.resourceAppId === lastRes).length})`))));
    }
    const st = STATUS[p.status] || STATUS.unknown;
    rows.push(el('tr', {},
      el('td', { class: 'indent' }, el('div', { class: 'app-name' }, p.value, p.highRisk ? el('span', { class: 'badge bad', title: 'Gives broad control over the tenant' }, 'High risk') : null), p.displayName ? el('div', { class: 'muted small' }, p.displayName) : null),
      el('td', {}, p.type === 'Role' ? 'Application' : 'Delegated'),
      el('td', {}, p.adminConsentRequired === null ? '—' : p.adminConsentRequired ? 'Yes' : 'No'),
      el('td', {}, badge(st)),
      el('td', { class: 'right' }, el('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: (e) => removePermission(p, e.currentTarget) }, 'Remove'))));
  }
  $('#permRows').replaceChildren(...rows);
}

async function removePermission(p, btn) {
  const extra = p.status === 'granted' ? ' Consent already granted will stay in place until an admin revokes it.' : '';
  if (!(await confirmAction('Remove permission?', `${p.resourceName} – ${p.value} (${p.type === 'Role' ? 'Application' : 'Delegated'}) will be removed from this app's requested permissions.${extra}`, 'Remove'))) return;
  await busy(btn, async () => {
    await api('DELETE', `/api/apps/${state.current.id}/permissions/${p.resourceAppId}/${p.type}/${p.id}`);
    toast('Permission removed');
    await loadPermissions();
  });
}

function openPermDialog() {
  perm.catalog = null;
  perm.selected.clear();
  $('#permStep1').classList.remove('hidden');
  $('#permStep2').classList.add('hidden');
  $('#apiSearch').value = '';
  $('#apiResults').replaceChildren();
  $('#permDialog').showModal();
}

async function chooseApi(appId, btn) {
  await busy(btn, async () => {
    perm.catalog = await api('GET', `/api/api-catalog/${appId}`);
    perm.selected.clear();
    $('#permApiName').textContent = perm.catalog.displayName;
    $('#permFilter').value = '';
    document.querySelector('input[name="permType"][value="Scope"]').checked = true;
    $('#permStep1').classList.add('hidden');
    $('#permStep2').classList.remove('hidden');
    renderPermList();
    $('#permFilter').focus();
  });
}

let apiSearchTimer;
function onApiSearch() {
  clearTimeout(apiSearchTimer);
  const q = $('#apiSearch').value.trim();
  const box = $('#apiResults');
  if (q.length < 2) { box.replaceChildren(); return; }
  apiSearchTimer = setTimeout(async () => {
    box.replaceChildren(el('li', { class: 'muted pad' }, 'Searching…'));
    try {
      const apis = await api('GET', `/api/api-catalog?q=${encodeURIComponent(q)}`);
      box.replaceChildren(...(apis.length ? apis.map((a) => el('li', {},
        el('button', { type: 'button', class: 'result', onclick: (e) => chooseApi(a.appId, e.currentTarget) },
          el('span', { class: 'app-name' }, a.displayName),
          el('span', { class: 'app-id' }, a.appId),
          el('span', { class: 'add' }, 'Select →')))) : [el('li', { class: 'muted pad' }, 'No APIs found')]));
    } catch (e) {
      box.replaceChildren(el('li', { class: 'pad error' }, `Search failed: ${e.message}`));
    }
  }, 300);
}

function renderPermList() {
  const type = document.querySelector('input[name="permType"]:checked').value;
  const q = $('#permFilter').value.trim().toLowerCase();
  const source = type === 'Role' ? perm.catalog.roles : perm.catalog.scopes;
  const existing = new Set(perm.list.filter((p) => p.resourceAppId === perm.catalog.appId).map((p) => `${p.type}:${p.id}`));
  const matches = source.filter((p) => !q || p.value?.toLowerCase().includes(q) || p.displayName?.toLowerCase().includes(q));
  const LIMIT = 200;
  const items = matches.slice(0, LIMIT).map((p) => {
    const key = `${type}:${p.id}`;
    const already = existing.has(key);
    const cb = el('input', { type: 'checkbox', ...(already || perm.selected.has(key) ? { checked: '' } : {}), ...(already ? { disabled: '' } : {}) });
    cb.addEventListener('change', () => { cb.checked ? perm.selected.add(key) : perm.selected.delete(key); updatePermCount(); });
    return el('li', {}, el('label', { class: already ? 'done' : '' }, cb,
      el('span', { class: 'perm-text' },
        el('span', { class: 'app-name' }, p.value,
          p.highRisk ? el('span', { class: 'badge bad', title: 'Gives broad control over the tenant; requests are logged for review' }, 'High risk') : null,
          p.adminConsentRequired ? el('span', { class: 'badge warn' }, 'Admin consent') : null,
          already ? el('span', { class: 'badge ok' }, 'Added') : null),
        el('span', { class: 'muted small' }, p.displayName))));
  });
  if (!source.length) items.push(el('li', { class: 'muted pad' }, `${perm.catalog.displayName} offers no ${type === 'Role' ? 'application' : 'delegated'} permissions.`));
  else if (!matches.length) items.push(el('li', { class: 'muted pad' }, 'No permissions match the filter.'));
  else if (matches.length > LIMIT) items.push(el('li', { class: 'muted pad' }, `Showing ${LIMIT} of ${matches.length}. Type to narrow the list.`));
  $('#permList').replaceChildren(...items);
  updatePermCount();
}

function updatePermCount() {
  const n = perm.selected.size;
  $('#permSelCount').textContent = n ? `${n} selected` : '';
  $('#permAddBtn').disabled = n === 0;
}

async function addPermissions(ev) {
  ev.preventDefault();
  const permissions = [...perm.selected].map((k) => { const [type, id] = k.split(':'); return { type, id }; });
  await busy($('#permAddBtn'), async () => {
    const r = await api('POST', `/api/apps/${state.current.id}/permissions`, { resourceAppId: perm.catalog.appId, permissions });
    $('#permDialog').close();
    toast(`${r.added} permission${r.added === 1 ? '' : 's'} added`);
    await loadPermissions();
  });
}

// ---------- federated credentials ----------
let ficEditing = null;
const fv = (name) => ($(`[data-f="${name}"]`)?.value || '').trim();

function ficCompute() {
  const sc = $('#ficScenario').value;
  if (sc === 'github') {
    const repo = `repo:${fv('ghOrg')}/${fv('ghRepo')}`;
    const ent = fv('ghEntity');
    const v = fv('ghValue');
    const subject = ent === 'environment' ? `${repo}:environment:${v}`
      : ent === 'branch' ? `${repo}:ref:refs/heads/${v}`
      : ent === 'tag' ? `${repo}:ref:refs/tags/${v}`
      : `${repo}:pull_request`;
    return { issuer: 'https://token.actions.githubusercontent.com', subject };
  }
  if (sc === 'kubernetes') return { issuer: fv('k8sIssuer'), subject: `system:serviceaccount:${fv('k8sNs')}:${fv('k8sSa')}` };
  if (sc === 'azdo') {
    return { issuer: `https://vstoken.dev.azure.com/${fv('adoOrgId')}`, subject: `sc://${fv('adoOrg')}/${fv('adoProject')}/${fv('adoConn')}` };
  }
  return { issuer: fv('otherIssuer'), subject: fv('otherSubject') };
}

function ficRefresh() {
  const sc = $('#ficScenario').value;
  document.querySelectorAll('#ficDialog fieldset').forEach((fs) => fs.classList.toggle('hidden', fs.dataset.scenario !== sc));
  $('#ghValueWrap').classList.toggle('hidden', fv('ghEntity') === 'pull_request');
  const { issuer, subject } = ficCompute();
  $('#ficPrevIssuer').textContent = issuer || '—';
  $('#ficPrevSubject').textContent = subject || '—';
}

function openFicDialog(existing = null) {
  ficEditing = existing;
  $('#ficForm').reset();
  $('#ficTitle').textContent = existing ? `Edit "${existing.name}"` : 'Add a federated credential';
  $('#ficSubmit').textContent = existing ? 'Save' : 'Add';
  $('#ficScenarioWrap').classList.toggle('hidden', !!existing);
  $('#ficName').disabled = !!existing; // name cannot be changed after creation
  if (existing) {
    $('#ficScenario').value = 'other';
    $('[data-f="otherIssuer"]').value = existing.issuer;
    $('[data-f="otherSubject"]').value = existing.subject;
    $('#ficName').value = existing.name;
    $('#ficAudience').value = existing.audiences[0] || 'api://AzureADTokenExchange';
    $('#ficDesc').value = existing.description || '';
  }
  ficRefresh();
  $('#ficDialog').showModal();
}

async function saveFic(ev) {
  ev.preventDefault();
  const { issuer, subject } = ficCompute();
  const body = { issuer, subject, audience: $('#ficAudience').value.trim(), description: $('#ficDesc').value.trim() };
  await busy(ev.submitter, async () => {
    if (ficEditing) {
      await api('PATCH', `/api/apps/${state.current.id}/federated/${ficEditing.id}`, body);
      toast('Federated credential updated');
    } else {
      await api('POST', `/api/apps/${state.current.id}/federated`, { ...body, name: $('#ficName').value.trim() });
      toast('Federated credential added');
    }
    $('#ficDialog').close();
    await selectApp(state.current.id);
  });
}

async function deleteFic(f, btn) {
  if (!(await confirmAction('Delete federated credential?', `"${f.name}" will be removed. Workloads using ${f.subject} will no longer be able to sign in as this app.`, 'Delete'))) return;
  await busy(btn, async () => {
    await api('DELETE', `/api/apps/${state.current.id}/federated/${f.id}`);
    toast('Federated credential deleted');
    await selectApp(state.current.id);
  });
}

// ---------- owners ----------
let searchTimer;
function onUserSearch() {
  clearTimeout(searchTimer);
  const q = $('#userSearch').value.trim();
  const box = $('#userResults');
  if (q.length < 2) { box.replaceChildren(); return; }
  searchTimer = setTimeout(async () => {
    box.replaceChildren(el('li', { class: 'muted pad' }, 'Searching…'));
    box.classList.remove('hidden');
    try {
      const users = await api('GET', `/api/users?q=${encodeURIComponent(q)}`);
      const ownerIds = new Set(state.current.owners.map((o) => o.id));
      box.replaceChildren(...(users.length ? users.map((u) => el('li', {},
        el('button', {
          type: 'button',
          class: 'result',
          ...(ownerIds.has(u.id) ? { disabled: '' } : {}),
          onclick: (e) => addOwner(u, e.currentTarget),
        },
        el('span', { class: 'app-name' }, u.displayName),
        el('span', { class: 'app-id' }, u.userPrincipalName || u.mail || ''),
        ownerIds.has(u.id) ? el('span', { class: 'badge ok' }, 'Owner') : el('span', { class: 'add' }, '+ Add')))) : [el('li', { class: 'muted pad' }, 'No users found')]));
      box.classList.remove('hidden');
    } catch (e) {
      box.replaceChildren(el('li', { class: 'pad error' }, `Search failed: ${e.message}`));
    }
  }, 300);
}

async function addOwner(u, btn) {
  await busy(btn, async () => {
    await api('POST', `/api/apps/${state.current.id}/owners`, { userId: u.id });
    toast(`${u.displayName} added as owner`);
    $('#ownerDialog').close();
    await selectApp(state.current.id);
  });
}

async function removeOwner(o, btn) {
  const self = o.id === state.me.oid;
  const msg = self
    ? 'You are removing YOURSELF. You will immediately lose access to manage this application.'
    : `${o.displayName} will no longer be able to manage this application.`;
  if (!(await confirmAction('Remove owner?', msg, 'Remove'))) return;
  await busy(btn, async () => {
    await api('DELETE', `/api/apps/${state.current.id}/owners/${o.id}`);
    toast('Owner removed');
    if (self) {
      state.current = null;
      $('#appDetail').classList.add('hidden');
      $('#emptyState').classList.remove('hidden');
      await loadApps();
    } else {
      await selectApp(state.current.id);
    }
  });
}

/** Refresh button: reload the app list, then the open app (details + API permissions). */
async function refreshAll(btn) {
  const id = state.current?.id;
  await busy(btn, async () => {
    state.apps = await api('GET', '/api/apps');
    if (id && !state.apps.some((a) => a.id === id)) {
      // Ownership was removed elsewhere (e.g. in the Entra portal) since the page loaded.
      state.current = null;
      $('#appDetail').classList.add('hidden');
      $('#emptyState').classList.remove('hidden');
      renderAppList();
      toast('You are no longer an owner of this application', 'bad');
      return;
    }
    renderAppList();
    if (id) await selectApp(id, true);
  });
}

// ---------- wiring ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
}));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#appFilter').addEventListener('input', renderAppList);
$('#refreshBtn').addEventListener('click', (e) => refreshAll(e.currentTarget));
$('#disableAppBtn').addEventListener('click', (e) => state.current && disableApp(e.currentTarget));
$('#newSecretBtn').addEventListener('click', openSecretDialog);
$('#secretForm').addEventListener('submit', createSecret);
$('#certForm').addEventListener('submit', uploadCert);
$('#certFile').addEventListener('change', (e) => { $('#certFileLabel').textContent = e.target.files[0]?.name || 'Choose public certificate (.cer, .crt, .pem)'; });
$('#userSearch').addEventListener('input', onUserSearch);
$('#addOwnerBtn').addEventListener('click', () => {
  $('#userSearch').value = '';
  $('#userResults').replaceChildren();
  $('#ownerDialog').showModal();
  $('#userSearch').focus();
});
$('#newFicBtn').addEventListener('click', () => openFicDialog());
$('#addPermBtn').addEventListener('click', openPermDialog);
document.querySelectorAll('[data-api]').forEach((b) => b.addEventListener('click', () => chooseApi(b.dataset.api, b)));
$('#apiSearch').addEventListener('input', onApiSearch);
$('#permFilter').addEventListener('input', renderPermList);
document.querySelectorAll('input[name="permType"]').forEach((r) => r.addEventListener('change', renderPermList));
$('#permBack').addEventListener('click', () => { $('#permStep2').classList.add('hidden'); $('#permStep1').classList.remove('hidden'); });
$('#permStep2').addEventListener('submit', addPermissions);
$('#ficForm').addEventListener('submit', saveFic);
$('#ficForm').addEventListener('input', ficRefresh);
$('#ficForm').addEventListener('change', ficRefresh);
$('#copySecret').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#secretValue').textContent);
  toast('Secret copied to clipboard');
});
$('#revealDialog').addEventListener('close', () => { $('#secretValue').textContent = ''; });

init();
