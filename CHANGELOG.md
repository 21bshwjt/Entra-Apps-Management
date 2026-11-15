# Changelog

## [Unreleased]

### Added
- **Disable app (one way):** owners can deactivate their app registration from its page (Graph beta `isDisabled = true`). The portal has no enable option; only an Entra administrator can reactivate the app. Logged as `app.disable`.

### Security
- **Guest (B2B) accounts are blocked at sign-in** with a 403 and logged as `guest_signin_blocked`. For defence in depth, also set *Assignment required = Yes* on the enterprise app and assign only member users.

### Fixed
- The yellow "expiring soon" dot in the app list was drawn as a large rounded square.

## [1.2.0] - 2026-11-14

Security hardening after a penetration-test style review.

### Security
- **Privileged apps:** new secrets, certificates, federated credentials and owners are blocked on apps granted high-risk permissions (e.g. `Directory.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`). Configurable with `PRIVILEGED_APPS=block|warn` and `PROTECTED_APP_IDS`. The app page explains why.
- **Token cleanup:** a user's cached tokens, including refresh tokens, are removed from memory on sign-out, after 1 hour idle, or at the absolute session limit.
- **Absolute session lifetime:** `SESSION_MAX_HOURS` (default 8); expired sessions are purged from memory.
- **Federated credential issuer allowlist:** `FEDERATED_ALLOWED_ISSUERS`; issuers with credentials, a query or a fragment are rejected.
- **Owners:** only users can be added; guests are blocked unless `ALLOW_GUEST_OWNERS=true`.
- **Rate limits:** per user on the API (600 requests per 5 minutes, 30 changes per minute) and per IP on sign-in (60 per 5 minutes).
- **Security log:** every denial (not owner, CSRF, bad origin, rate limit, blocked change, disallowed issuer, guest owner) is logged as JSON with `"security":true`.
- **High-risk API permissions** are badged in the UI and logged when requested.
- **Weak certificates rejected:** RSA keys under 2048 bits and SHA-1/MD5 signatures.
- **Sign-out is a same-origin POST**, so other sites can't sign users out.
- `Cache-Control: no-store` on API and sign-in responses; error pages are plain text.

### Fixed
- Replacing a secret with an invalid `replaceKeyId` no longer leaves a new secret behind whose value nobody received.
- A malformed or `null` `Origin` header returned 500; it is now rejected with 403.

### Changed
- `@azure/msal-node` upgraded from 2.x to 7.2.2 (`npm audit`: 0 vulnerabilities).
- **Node.js 20 or later is now required** (Node 18 is end-of-life).
- README: security settings, privileged apps, security log format and an App Service hardening checklist.

## [1.1.0] - 2026-11-14

### Added
- **Expiry e-mails to app owners** (optional, `NOTIFY_ENABLED=true`). The portal itself checks once a day, with no external scheduler:
  - every day from 30 days before a client secret or certificate expires;
  - once a week after it has expired, until it is deleted;
  - separate e-mails for client secrets and certificates, each with its own subject and steps;
  - no e-mail for disabled apps;
  - sent to the app's owners only, from a shared mailbox limited through Exchange Online RBAC.
- `npm run notify:check` (dry run) and `npm run notify:send-now`.
- **Disabled apps are marked with ⛔** in the app list, with a "Disabled" badge and an explanation on the app page. Covers deactivated app registrations, enterprise apps with sign-in turned off, and apps disabled by Microsoft.

### Changed
- Static files are always revalidated, so browsers pick up a new `app.js` after an update.

### Fixed
- README: Stars/Forks badges, links and `git clone` / `cd` commands now point to this repository.

## [1.0.0]

- First release: client secrets, certificates, federated credentials, API permissions and owners for the apps you own.
