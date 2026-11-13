# Entra App Self-Service Portal

A web app where users sign in with **Entra ID (SSO)** and manage **only the app registrations they own**. App owners can rotate their own credentials, permissions and owners without opening a ticket with the identity team. Admin consent stays with administrators.

| Area | What owners can do |
|---|---|
| **Client secrets** | Create a secret (the value is shown **once**), optionally delete an old one in the same step, and delete secrets. Each secret shows Valid, Expiring (≤ 30 days) or Expired. |
| **Certificates** | Upload a public certificate (`.cer` / `.crt` / `.pem`) and delete certificates. Each certificate shows Valid, Expiring or Expired. |
| **Federated credentials** | Add, edit and delete federated credentials (workload identity federation). Presets are included for GitHub Actions, Kubernetes, Azure DevOps and any other OIDC issuer, with a live preview of the issuer and subject. |
| **API permissions** | View requested permissions and their consent status, add delegated or application permissions for any API in the tenant, and remove them. A link opens the Entra admin-consent page. |
| **Owners** | Add owners by searching name, UPN, email or object ID, and remove owners. The last owner can't be removed. |

---

## Contents
1. [How it works](#how-it-works)
2. [Register the portal in Entra ID](#1-register-the-portal-in-entra-id)
3. [Configure `.env`](#2-configure-env)
4. [Run locally](#3-run-locally)
5. [Using the portal](#4-using-the-portal)
6. [Troubleshooting](#5-troubleshooting)
7. [Deploying](#6-deploying-eg-azure-app-service)
8. [Security](#security)
9. [REST API reference](#rest-api-reference)
10. [Project layout](#project-layout)

---

## How it works

```
Browser ──session cookie──► Node.js / Express ──delegated token──► Microsoft Graph v1.0
                             • MSAL auth-code flow + PKCE (Entra SSO)
                             • tokens kept server-side only
                             • ownership re-checked on every action
                             • JSON audit log of every change
```

- **Delegated permissions:** every Graph call runs *as the signed-in user*, so Entra itself only lets a normal user change apps they own.
- **Ownership guard:** before every action the server also checks that the app is in the user's `/me/ownedObjects`. Admins with tenant-wide rights still see and change **only apps they personally own** in this portal.

---

## 1. Register the portal in Entra ID

You need an admin once, to grant consent.

### Option A: Entra admin center

1. **Entra admin center → App registrations → New registration**
   - Name: `Entra App Self-Service`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Web** (not SPA), value `http://localhost:3000/auth/callback`
2. **Overview:** copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret.** Copy the **Value**, not the Secret ID.
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions.** Add these:

   | Permission | Why |
   |---|---|
   | `openid`, `profile`, `offline_access` | Sign-in and token refresh |
   | `User.Read` | Signed-in user's profile |
   | `User.ReadBasic.All` | Search users to add as owners |
   | `Application.ReadWrite.All` | Read and update the apps the user owns. Entra still enforces ownership. |
   | `DelegatedPermissionGrant.Read.All` *(optional)* | Shows consent status for **delegated** permissions on the API permissions tab. Without it, that status shows "Unknown". |

5. Click **Grant admin consent for <tenant>**.
6. *(Recommended)* **Enterprise applications → Entra App Self-Service → Properties → Assignment required = Yes**, then assign the users or groups allowed to use the portal.

### Option B: Azure CLI (run as an admin)

```bash
APP_ID=$(az ad app create --display-name "Entra App Self-Service" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris http://localhost:3000/auth/callback \
  --query appId -o tsv)

GRAPH=00000003-0000-0000-c000-000000000000
for P in openid profile offline_access User.Read User.ReadBasic.All Application.ReadWrite.All DelegatedPermissionGrant.Read.All; do
  ID=$(az ad sp show --id $GRAPH --query "oauth2PermissionScopes[?value=='$P'].id" -o tsv)
  az ad app permission add --id $APP_ID --api $GRAPH --api-permissions $ID=Scope
done

az ad sp create --id $APP_ID
az ad app permission admin-consent --id $APP_ID
az ad app credential reset --id $APP_ID --display-name portal --years 1 --query password -o tsv  # client secret
echo "CLIENT_ID=$APP_ID"
az account show --query tenantId -o tsv                                                          # tenant id
```

---

## 2. Configure `.env`

The app reads **`.env`**. `.env.example` is only a template; don't put real values in it.

```powershell
Copy-Item .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `TENANT_ID` | ✅ | Directory (tenant) ID |
| `CLIENT_ID` | ✅ | Application (client) ID of the portal |
| `CLIENT_SECRET` | ✅ | Client secret **Value** of the portal |
| `REDIRECT_URI` | ✅ | Must exactly match the **Web** redirect URI, e.g. `http://localhost:3000/auth/callback` |
| `POST_LOGOUT_REDIRECT_URI` | | Where to land after sign-out, e.g. `http://localhost:3000/` |
| `PORT` | | Default `3000` |
| `SESSION_SECRET` | ✅ | Long random string that signs the session cookie (see below) |
| `MAX_SECRET_MONTHS` | | Longest lifetime offered for new client secrets (1–24, default 24) |

Generate `SESSION_SECRET` with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> `.env` is in `.gitignore`. Never commit it.

---

## 3. Run locally

Requires **Node.js 18 or later**. Entra accepts `http://localhost` redirect URIs, so you don't need HTTPS locally.

```powershell
npm install
npm start          # or: npm run dev   (auto-restarts on code changes)
```

Open **http://localhost:3000** and click **Sign in with Microsoft**.

> The server reads `.env` **only when it starts**. After editing `.env`, stop it (**Ctrl+C**) and run `npm start` again.
> After updating files in `public/`, reload the browser with **Ctrl+F5**.

### Test data
- **An app to manage:** create a throwaway app registration and add yourself under **Owners**. Only apps you own appear in the portal.
- **A test certificate** (upload only the public part):
  ```powershell
  $c = New-SelfSignedCertificate -Subject "CN=test-selfservice" -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(1)
  Export-Certificate -Cert $c -FilePath .\test.cer
  ```
  or `openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out test.pem -days 365 -subj "/CN=test"`, then upload `test.pem`.
- **The non-owner path:** sign in as a user who owns no apps. The list should be empty.

---

## 4. Using the portal

The left pane lists the apps you own. A coloured dot shows credential health: 🟢 all valid, 🟡 something expires within 30 days, 🔴 something has expired. Select an app to open its tabs.

### Client secrets
- **+ New client secret:** enter a description and choose an expiry (1–24 months). You can also pick an existing secret to **replace**; it is deleted right after the new one is created.
- The secret value is shown **once**. Copy it into Key Vault or your pipeline's secret store before closing the dialog.
- **Delete** removes a secret immediately. Anything still using it stops working.

### Certificates
- Choose a `.cer`, `.crt` or `.pem` file containing the **public** certificate only, optionally add a description, then click **Upload certificate**.
- Rejected files: anything containing a private key (e.g. PFX, or PEM with a key), expired certificates, and certificates already on the app.
- Existing certificates are kept when a new one is added.

### Federated credentials
Click **+ Add federated credential** and choose a scenario:

| Scenario | You enter | Issuer and subject created |
|---|---|---|
| GitHub Actions | Organization, repository, entity (environment / branch / tag / pull request) | `https://token.actions.githubusercontent.com`<br>`repo:org/repo:environment:prod`, `…:ref:refs/heads/main`, `…:ref:refs/tags/v1`, `…:pull_request` |
| Kubernetes | Cluster OIDC issuer URL, namespace, service account | `system:serviceaccount:<ns>:<sa>` |
| Azure DevOps | Organization ID, organization, project, service connection | `https://vstoken.dev.azure.com/<orgId>`<br>`sc://<org>/<project>/<connection>` |
| Other issuer | Issuer URL, subject | As entered |

- The audience defaults to `api://AzureADTokenExchange`.
- **Edit** changes the issuer, subject, audience and description. The **name can't be changed** after creation.
- Limits: 20 per app, issuer must be `https://`, no wildcard subjects, and names and issuer + subject pairs must be unique.

### API permissions
- **View:** permissions are grouped by API. Each shows its type (Delegated / Application), whether admin consent is required, and a status:
  - **Granted for tenant:** admin consent is in place.
  - **User consent only:** some users have consented, but there's no tenant-wide grant.
  - **Not granted:** requested, but not consented yet.
  - **Unknown:** the portal can't read delegated grants. Add the optional `DelegatedPermissionGrant.Read.All` permission to the portal.
- **+ Add a permission:** pick an API (shortcuts for Microsoft Graph, Azure Service Management, SharePoint and Azure Key Vault, or search by name or app ID). Then choose **Delegated** or **Application**, filter, tick the permissions you want, and click **Add permissions**.
- **Grant admin consent in Entra ↗:** opens this app's API permissions page in the Entra admin center for an administrator.
- **Remove** takes the permission off the app's requested list.

> Adding a permission only **requests** it; owners can't grant admin consent. Removing a permission does **not** revoke consent already granted. An admin has to revoke it in Entra.

### Owners
- **+ Add owner:** type at least 2 characters of a name, UPN or email, or paste a full UPN or object ID. Then click the user.
- **Remove:** the last owner can't be removed. Removing **yourself** asks for confirmation, because you immediately lose access to the app.

---

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required environment variable …` at startup | `.env` is missing or incomplete. Values must be in `.env`, not `.env.example`. |
| `AADSTS700038: 00000000-… is not a valid application identifier` | `CLIENT_ID` is still the placeholder. Fill in `.env`, then **restart** the server. Open a new tab rather than refreshing the error page. |
| `AADSTS50011` redirect URI mismatch | The registration needs a **Web** (not SPA) redirect URI exactly equal to `REDIRECT_URI`. |
| `AADSTS65001` consent required | Admin consent wasn't granted for the portal's permissions. |
| `AADSTS7000215` invalid client secret | You used the secret **ID** instead of its **Value**, or the secret expired. |
| `EADDRINUSE: address already in use :::3000` | Another server is already running. Stop it with **Ctrl+C**, or run `Get-Process node \| Stop-Process -Force` (this stops all Node processes), or change `PORT` together with both localhost URLs. |
| New buttons or tabs don't appear | The browser is showing cached files. Press **Ctrl+F5**. |
| Owner search shows "Search failed: …" | Check that `User.ReadBasic.All` is consented. The server terminal prints details as `[4xx] … ` lines. |
| API permission status shows "Unknown" | Add `DelegatedPermissionGrant.Read.All` (Delegated) to the portal and grant admin consent. |
| "You are not an owner of this application" | The app isn't in your owned objects. Ask a current owner to add you. |
| "Session expired, please sign in again" | The 1-hour idle session ended or the server restarted (sessions are in memory). Sign in again. |

Graph and validation errors are logged in the server terminal as `[status] METHOD path: code - message`.

---

## 6. Deploying (e.g. Azure App Service)

- Add the production redirect URI `https://<host>/auth/callback` to the app registration, and set `REDIRECT_URI` and `POST_LOGOUT_REDIRECT_URI` to match. With an `https://` redirect URI, cookies are automatically marked `Secure`.
- Store `CLIENT_SECRET` and `SESSION_SECRET` in **Key Vault** or App Settings, not in files. Consider a certificate or managed identity for the portal's own credential.
- Sessions and the MSAL token cache are **in memory**. For more than one instance, or to keep sessions across restarts, use a shared store (e.g. Redis via `connect-redis`) and a distributed MSAL cache.
- Turn on **Assignment required** on the enterprise app to limit who can use the portal.
- Send stdout to Log Analytics or your SIEM to keep the audit log.

---

## Security

| Control | Implementation |
|---|---|
| Authentication | Entra OIDC auth-code flow with PKCE and `state` check; session ID regenerated after login |
| Token handling | Tokens stay in the server-side MSAL cache; the browser only holds an HttpOnly, SameSite=Lax cookie (1-hour idle timeout) |
| Authorization | Graph delegated permissions (Entra enforces ownership) **plus** a server-side `/me/ownedObjects` check on every action |
| CSRF | Writes require the `X-Requested-With: fetch` header and a same-origin `Origin` |
| Input validation | All IDs must be GUIDs; names, URLs, subjects and lengths are validated on the server |
| Client secrets | Lifetime capped by `MAX_SECRET_MONTHS` (≤ 24); the value is returned once and never stored or logged |
| Certificates | Parsed on the server; private keys, expired certificates and duplicates are rejected; existing certificates are preserved on update |
| Federated credentials | `https` issuers only, no wildcard subjects, duplicates rejected, 20-per-app limit |
| API permissions | Permissions are checked against the target API's published scopes and roles; owners can only *request* them, never grant consent |
| Owners | The last owner can't be removed; removing yourself needs explicit confirmation |
| Headers | `helmet` with a strict CSP (no inline scripts or styles), `frame-ancestors 'none'`, no `x-powered-by` |
| Errors | No stack traces sent to the client |

### Audit log
Every change writes one JSON line to stdout. Example:

```json
{"ts":"2026-11-13T10:15:02.123Z","audit":true,"user":"jane@contoso.com","userOid":"…","action":"secret.add","appId":"…","appName":"Payroll API","keyId":"…","months":6,"replaced":null}
```

Actions: `secret.add`, `secret.remove`, `certificate.add`, `certificate.remove`, `federated.add`, `federated.update`, `federated.remove`, `permission.add`, `permission.remove`, `owner.add`, `owner.remove`.

---

## REST API reference

All routes need a signed-in session. Routes under `/api/apps/:id` also require the caller to own the app. Write requests need the header `X-Requested-With: fetch`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/auth/signin` · `/auth/callback` · `/auth/signout` | Sign in and sign out |
| GET | `/api/me` | Current user |
| GET | `/api/apps` | Apps the user owns |
| GET | `/api/apps/:id` | App details, owners and federated credentials |
| POST | `/api/apps/:id/secrets` | Add a secret `{displayName, months, replaceKeyId?}` |
| DELETE | `/api/apps/:id/secrets/:keyId` | Delete a secret |
| POST | `/api/apps/:id/certificates` | Upload a certificate `{content (base64), displayName?}` |
| DELETE | `/api/apps/:id/certificates/:keyId` | Delete a certificate |
| POST | `/api/apps/:id/federated` | Add a federated credential `{name, issuer, subject, audience?, description?}` |
| PATCH | `/api/apps/:id/federated/:ficId` | Update a federated credential `{issuer, subject, audience?, description?}` |
| DELETE | `/api/apps/:id/federated/:ficId` | Delete a federated credential |
| GET | `/api/apps/:id/permissions` | Requested permissions with consent status |
| POST | `/api/apps/:id/permissions` | Add permissions `{resourceAppId, permissions:[{id, type:"Scope"\|"Role"}]}` |
| DELETE | `/api/apps/:id/permissions/:resourceAppId/:type/:permId` | Remove a permission |
| GET | `/api/api-catalog?q=` | Search APIs (service principals) |
| GET | `/api/api-catalog/:appId` | Delegated scopes and application roles an API offers |
| POST | `/api/apps/:id/owners` | Add an owner `{userId}` |
| DELETE | `/api/apps/:id/owners/:ownerId` | Remove an owner |
| GET | `/api/users?q=` | Search users |

---

## Project layout

```
.env.example        Configuration template (copy to .env)
package.json        Dependencies and npm scripts
src/server.js       Express app, session, security headers, error handler
src/auth.js         MSAL sign-in / callback / sign-out, token acquisition
src/graph.js        Microsoft Graph helpers
src/api.js          REST API, ownership guard, validation, audit log
public/index.html   UI markup (tabs and dialogs)
public/app.js       UI logic
public/styles.css   Styles (light and dark mode)
```
