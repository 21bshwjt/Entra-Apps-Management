# Changelog

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
