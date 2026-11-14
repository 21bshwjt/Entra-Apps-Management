'use strict';

/**
 * Expiry e-mails to app owners, sent by the portal itself (no external scheduler).
 *
 *  - Secret or certificate expires within NOTIFY_DAYS_BEFORE days → one e-mail per day.
 *  - Secret or certificate has expired → one e-mail every NOTIFY_EXPIRED_EVERY_DAYS days, until it is deleted.
 *  - Disabled apps (deactivated, sign-in turned off, or disabled by Microsoft) → no e-mail.
 *  - Recipients: the app's owners only (enabled users with a mailbox), all in "To".
 *  - One e-mail per app per run, listing every credential that is due.
 *
 * The check runs inside the portal: every 15 minutes it looks whether today's run
 * has happened yet and, once the clock is past NOTIFY_HOUR, runs it.
 *
 * Command line (for testing):
 *   npm run notify:check     → shows who would get which e-mail; sends nothing, saves nothing
 *   npm run notify:send-now  → runs the check now and sends (duplicates are still prevented)
 */

if (require.main === module) require('dotenv').config();

const fs = require('fs');
const path = require('path');
const graph = require('./graph');

const DAY = 24 * 60 * 60 * 1000;
const TICK = 15 * 60 * 1000;

function config() {
  const int = (v, def, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  let portalUrl = (process.env.PORTAL_URL || '').trim();
  if (!portalUrl) {
    try { portalUrl = new URL(process.env.REDIRECT_URI).origin; } catch { portalUrl = ''; }
  }
  return {
    enabled: String(process.env.NOTIFY_ENABLED || '').toLowerCase() === 'true',
    sender: (process.env.NOTIFY_SENDER || '').trim(),
    daysBefore: int(process.env.NOTIFY_DAYS_BEFORE, 30, 1, 365),
    expiredEvery: int(process.env.NOTIFY_EXPIRED_EVERY_DAYS, 7, 1, 365),
    hour: int(process.env.NOTIFY_HOUR, 8, 0, 23),
    portalUrl: portalUrl.replace(/\/+$/, ''),
    stateFile: path.resolve(process.env.NOTIFY_STATE_FILE || path.join(__dirname, '..', 'data', 'notify-state.json')),
  };
}

// ---------- state: when each credential was last e-mailed ----------
function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastRunDate: s.lastRunDate || null, sent: s.sent || {} };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[notify] Could not read ${file}, starting fresh: ${e.message}`);
    return { lastRunDate: null, sent: {} };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Whole calendar days (server time zone) between two instants. */
const calendarDaysBetween = (a, b) => {
  const day = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  return Math.round((day(b) - day(a)) / DAY);
};

// ---------- one run ----------
async function runOnce({ dryRun = false } = {}) {
  const cfg = config();
  if (!cfg.sender && !dryRun) throw new Error('NOTIFY_SENDER is not set');
  const { getAppToken } = require('./auth');
  const state = loadState(cfg.stateFile);
  const now = Date.now();
  const summary = { checkedApps: 0, emailed: 0, skippedDisabled: 0, skippedNoOwners: 0, failed: 0 };

  const token = await getAppToken();
  let apps;
  try {
    apps = await graph.listAllApps(token);
  } catch (e) {
    if (e.status === 403) e.message += ' → grant the Microsoft Graph APPLICATION permission Application.Read.All to the portal and click "Grant admin consent".';
    throw e;
  }
  summary.checkedApps = apps.length;

  // 1. Which credentials are due today?
  const live = new Set();
  const candidates = [];
  for (const app of apps) {
    const creds = [
      ...(app.passwordCredentials || []).map((c) => ({ ...c, kind: 'Client secret' })),
      ...(app.keyCredentials || []).map((c) => ({ ...c, kind: 'Certificate' })),
    ];
    const due = [];
    for (const c of creds) {
      if (!c.keyId || !c.endDateTime) continue;
      live.add(`${app.id}:${c.keyId}`);
      const end = new Date(c.endDateTime).getTime();
      const expired = end <= now;
      if (!expired && end - now > cfg.daysBefore * DAY) continue;
      const stateKey = `${app.id}:${c.keyId}:${expired ? 'expired' : 'expiring'}`;
      const last = state.sent[stateKey] ? new Date(state.sent[stateKey]).getTime() : null;
      const isDue = expired
        ? last === null || calendarDaysBetween(last, now) >= cfg.expiredEvery // weekly after expiry
        : last === null || calendarDaysBetween(last, now) >= 1; // daily before expiry
      if (isDue) due.push({ ...c, expired, end, stateKey });
    }
    if (due.length) candidates.push({ app, due });
  }

  // 2. Skip disabled apps.
  let spEnabled = null;
  if (candidates.length) {
    spEnabled = await graph.getSpEnabledMap(token, candidates.map((c) => c.app.appId)).catch((e) => {
      console.warn(`[notify] Could not read enterprise app sign-in state: ${e.message}`);
      return null;
    });
  }

  for (const { app, due } of candidates) {
    const name = app.displayName || app.appId;
    const deactivated = await graph.isAppDeactivated(token, app.id).catch((e) => {
      console.warn(`[notify] Could not read deactivation state of "${name}": ${e.message}`);
      return null;
    });
    const byMicrosoft = app.disabledByMicrosoftStatus && app.disabledByMicrosoftStatus !== 'NotDisabled';
    if (deactivated === true || spEnabled?.get(app.appId) === false || byMicrosoft) {
      summary.skippedDisabled++;
      console.log(`[notify] Skipped "${name}": app is disabled.`);
      continue;
    }

    // 3. Owners: enabled users with a mailbox.
    let owners;
    try {
      owners = (await graph.listUserOwners(token, app.id)).filter((o) => o.accountEnabled !== false && o.mail);
    } catch (e) {
      summary.failed++;
      console.error(`[notify] Could not read owners of "${name}": ${e.message}`);
      continue;
    }
    const seen = new Set();
    owners = owners.filter((o) => !seen.has(o.mail.toLowerCase()) && seen.add(o.mail.toLowerCase()));
    if (!owners.length) {
      summary.skippedNoOwners++;
      console.log(`[notify] Skipped "${name}": no enabled owner with a mailbox.`);
      continue;
    }

    // 4. Send one e-mail per app.
    const message = buildMessage(app, due, owners, cfg, now);
    if (dryRun) {
      summary.emailed++;
      console.log(`[notify] (dry run) Would e-mail ${owners.map((o) => o.mail).join(', ')}: "${message.subject}"`);
      for (const d of due) console.log(`           - ${d.kind} "${d.displayName || d.keyId}": ${statusText(d, now)}`);
      continue;
    }
    try {
      await graph.sendMail(token, cfg.sender, message);
    } catch (e) {
      summary.failed++;
      const hint = e.status === 403 || e.status === 401
        ? ' → check the Exchange Online "Application Mail.Send" role assignment for the portal and NOTIFY_SENDER.'
        : '';
      console.error(`[notify] Could not send e-mail for "${name}": [${e.status}] ${e.message}${hint}`);
      continue;
    }
    const sentAt = new Date(now).toISOString();
    for (const d of due) state.sent[d.stateKey] = sentAt;
    saveState(cfg.stateFile, state);
    summary.emailed++;
    console.log(JSON.stringify({
      ts: sentAt, audit: true, user: 'system', action: 'notify.sent',
      appId: app.appId, appName: app.displayName, recipients: owners.length, keyIds: due.map((d) => d.keyId),
    }));
  }

  if (!dryRun) {
    // Forget credentials that no longer exist, so their e-mails stop for good.
    for (const k of Object.keys(state.sent)) {
      if (!live.has(k.split(':').slice(0, 2).join(':'))) delete state.sent[k];
    }
    // A run with failures is retried on the next tick; already-sent e-mails are not repeated.
    if (!summary.failed) state.lastRunDate = localDate(new Date(now));
    saveState(cfg.stateFile, state);
  }
  return summary;
}

// ---------- e-mail ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (t) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

function statusText(d, now) {
  if (d.expired) {
    const ago = Math.floor((now - d.end) / DAY);
    return ago < 1 ? 'Expired today' : `Expired ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  const left = Math.ceil((d.end - now) / DAY);
  return `Expires in ${left} day${left === 1 ? '' : 's'}`;
}

function buildMessage(app, due, owners, cfg, now) {
  const name = app.displayName || app.appId;
  const anyExpired = due.some((d) => d.expired);
  const subject = `${anyExpired ? 'Expired' : 'Expiring'} credential${due.length === 1 ? '' : 's'}: ${name}`;
  const rows = due
    .sort((a, b) => a.end - b.end)
    .map((d) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e1e4e8">${esc(d.kind)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e1e4e8">${esc(d.displayName || '(no description)')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e1e4e8">${esc(fmtDate(d.end))} (UTC)</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e1e4e8;color:${d.expired ? '#a4262c' : '#8a5300'};font-weight:600">${esc(statusText(d, now))}</td>
      </tr>`).join('');
  const link = cfg.portalUrl
    ? `<p><a href="${esc(cfg.portalUrl)}" style="display:inline-block;padding:8px 16px;background:#0f6cbd;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Open the Entra App Self-Service portal</a></p>`
    : '<p>Open the Entra App Self-Service portal to renew or remove these credentials.</p>';
  const content = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2328">
    <p>Hello,</p>
    <p>You are an owner of the Entra ID app registration <b>${esc(name)}</b> (App ID <code>${esc(app.appId)}</code>).
       The following credential${due.length === 1 ? ' needs' : 's need'} your attention:</p>
    <table style="border-collapse:collapse;font-size:13px">
      <tr style="background:#f6f8fa;text-align:left">
        <th style="padding:6px 10px">Type</th><th style="padding:6px 10px">Description</th>
        <th style="padding:6px 10px">Expiry date</th><th style="padding:6px 10px">Status</th>
      </tr>${rows}
    </table>
    <p>Create a new secret or certificate, update the systems that use it, then delete the old one.
       Expired credentials no longer work; delete them to stop these reminders.</p>
    ${link}
    <p style="color:#5f6b7a;font-size:12px">You get this e-mail daily from ${cfg.daysBefore} days before expiry,
       and every ${cfg.expiredEvery} days once a credential has expired, until it is deleted.</p>
  </div>`;
  return {
    subject,
    body: { contentType: 'HTML', content },
    toRecipients: owners.map((o) => ({ emailAddress: { address: o.mail, name: o.displayName || o.mail } })),
  };
}

// ---------- in-portal timer ----------
function start() {
  const cfg = config();
  if (!cfg.enabled) {
    console.log('[notify] Expiry e-mails are off (set NOTIFY_ENABLED=true to turn them on).');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(cfg.sender)) {
    console.error('[notify] NOTIFY_SENDER is missing or not an e-mail address; expiry e-mails are off.');
    return;
  }
  console.log(`[notify] Expiry e-mails on: daily from ${cfg.daysBefore} days before expiry, every ${cfg.expiredEvery} days after expiry, `
    + `checked from ${pad(cfg.hour)}:00 server time, sent from ${cfg.sender}.`);

  let running = false;
  const tick = async () => {
    const now = new Date();
    if (running || now.getHours() < cfg.hour) return;
    if (loadState(cfg.stateFile).lastRunDate === localDate(now)) return;
    running = true;
    try {
      const s = await runOnce();
      console.log(`[notify] Done: ${s.checkedApps} apps checked, ${s.emailed} e-mailed, ${s.skippedDisabled} skipped (disabled), `
        + `${s.skippedNoOwners} skipped (no owner mailbox), ${s.failed} failed.`);
    } catch (e) {
      console.error(`[notify] Run failed, will retry in 15 minutes: ${e.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15 * 1000).unref();
  setInterval(tick, TICK).unref();
}

module.exports = { start, runOnce };

// ---------- command line ----------
if (require.main === module) {
  const dryRun = !process.argv.includes('--send');
  runOnce({ dryRun })
    .then((s) => {
      console.log(`[notify] ${dryRun ? 'Dry run' : 'Run'} finished: ${JSON.stringify(s)}`);
      process.exit(s.failed ? 1 : 0);
    })
    .catch((e) => {
      console.error(`[notify] Failed: ${e.message}`);
      process.exit(1);
    });
}
