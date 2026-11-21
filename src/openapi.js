'use strict';

/**
 * OpenAPI 3.0 description of the portal's REST API, served to SuperAdmins at
 * /api-docs/openapi.json and rendered by Swagger UI at /api-docs.
 * Keep it in step with src/api.js when routes change.
 */

const guid = { type: 'string', format: 'uuid' };
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const ok = (description, schema = ref('Ok')) => ({ description, content: json(schema) });
const err = (description) => ({ description, content: json(ref('Error')) });

const pathParam = (name, description) => ({ name, in: 'path', required: true, description, schema: guid });
const P = {
  id: pathParam('id', 'Application **object** ID (not the client ID)'),
  keyId: pathParam('keyId', 'Key ID of the secret or certificate'),
  ficId: pathParam('ficId', 'Federated credential ID'),
  ownerId: pathParam('ownerId', 'Object ID of the owner'),
  resourceAppId: pathParam('resourceAppId', 'App ID of the API (e.g. Microsoft Graph `00000003-0000-0000-c000-000000000000`)'),
  permId: pathParam('permId', 'ID of the scope or app role'),
  apiAppId: pathParam('appId', 'App ID of the API'),
};

/** Errors every /apps/{id} route can return. */
const appErrors = {
  400: err('Invalid input'),
  401: err('Not signed in, or the session expired'),
  403: err('Members: not an owner of this app (`not_owner`). Also: CSRF header missing, bad origin, privileged-app block, or Graph refused (SuperAdmin without an active Entra admin role)'),
  404: err('Application (or item) not found'),
  429: err('Rate limit hit (600 requests / 5 min, 30 changes / min per user)'),
};
const writeErrors = { ...appErrors };

function buildSpec({ maxSecretMonths }) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Entra App Self-Service Portal API',
      version: require('../package.json').version,
      description: [
        'REST API behind the portal. **Every call runs as you**, with your current portal session and your own Entra rights.',
        '',
        '- **Members** can only use `/apps/{id}` routes on apps they own. **SuperAdmins** can use them on any app.',
        '- **Write requests** (POST / PATCH / DELETE) need the header `X-Requested-With: fetch`. This page adds it for you.',
        '- **Try it out makes real changes** to real app registrations, and every change is written to the audit log.',
        '- New client secret values are shown **once**, in the response body.',
      ].join('\n'),
    },
    servers: [{ url: '/api', description: 'This portal' }],
    tags: [
      { name: 'Session', description: 'Who is signed in' },
      { name: 'Apps', description: 'List, open, disable and enable app registrations' },
      { name: 'Client secrets' },
      { name: 'Certificates' },
      { name: 'Federated credentials', description: 'Workload identity federation' },
      { name: 'API permissions', description: 'Requested permissions (requiredResourceAccess) and consent status' },
      { name: 'Owners' },
      { name: 'Directory', description: 'Search users and APIs' },
    ],
    paths: {
      '/me': {
        get: {
          tags: ['Session'],
          summary: 'Current user and role',
          responses: { 200: ok('Signed-in user', ref('Me')), 401: err('Not signed in') },
        },
      },
      '/apps': {
        get: {
          tags: ['Apps'],
          summary: 'List apps (Members: owned apps · SuperAdmins: all apps)',
          responses: { 200: ok('App registrations, sorted by name', { type: 'array', items: ref('App') }), 401: err('Not signed in') },
        },
      },
      '/apps/{id}': {
        get: {
          tags: ['Apps'],
          summary: 'App details, owners and federated credentials',
          parameters: [P.id],
          responses: { 200: ok('App details', ref('AppDetail')), ...appErrors },
        },
      },
      '/apps/{id}/disable': {
        post: {
          tags: ['Apps'],
          summary: 'Deactivate the app registration',
          description: 'Sets Graph beta `isDisabled = true`. No new tokens can be issued for the app. Audited as `app.disable`.',
          parameters: [P.id],
          requestBody: { required: false, content: json(ref('Reason')) },
          responses: { 200: ok('Disabled (or `alreadyDisabled: true`)', ref('DisableResult')), ...writeErrors },
        },
      },
      '/apps/{id}/enable': {
        post: {
          tags: ['Apps'],
          summary: 'Re-activate a deactivated app (SuperAdmins only)',
          description: 'Sets Graph beta `isDisabled = false`. Does not change the enterprise app\'s "Enabled for users to sign-in" setting. Members get 403 (`enable_not_allowed`). Audited as `app.enable`.',
          parameters: [P.id],
          requestBody: { required: false, content: json(ref('Reason')) },
          responses: {
            200: ok('Enabled (or `alreadyEnabled: true`)', ref('EnableResult')),
            ...writeErrors,
            403: err('Not a SuperAdmin (`enable_not_allowed`), or Graph refused'),
            409: err('Disabled by Microsoft; cannot be re-enabled here'),
          },
        },
      },
      '/apps/{id}/secrets': {
        post: {
          tags: ['Client secrets'],
          summary: 'Create a client secret (optionally replacing one)',
          description: 'The secret value is returned **once** in `secretText` and is never stored or logged. Blocked on privileged apps when `PRIVILEGED_APPS=block`.',
          parameters: [P.id],
          requestBody: { required: true, content: json(ref('NewSecret')) },
          responses: { 200: ok('Created', ref('CreatedSecret')), ...writeErrors },
        },
      },
      '/apps/{id}/secrets/{keyId}': {
        delete: {
          tags: ['Client secrets'],
          summary: 'Delete a client secret',
          parameters: [P.id, P.keyId],
          responses: { 200: ok('Deleted'), ...writeErrors },
        },
      },
      '/apps/{id}/certificates': {
        post: {
          tags: ['Certificates'],
          summary: 'Upload a public certificate',
          description: 'Rejects private keys, expired, duplicate and weak certificates (RSA < 2048 bits, SHA-1/MD5). Existing certificates are kept.',
          parameters: [P.id],
          requestBody: { required: true, content: json(ref('NewCertificate')) },
          responses: { 200: ok('Uploaded', ref('UploadedCertificate')), ...writeErrors, 409: err('Existing certificates could not be read safely') },
        },
      },
      '/apps/{id}/certificates/{keyId}': {
        delete: {
          tags: ['Certificates'],
          summary: 'Delete a certificate',
          parameters: [P.id, P.keyId],
          responses: { 200: ok('Deleted'), ...writeErrors, 409: err('Existing certificates could not be read safely') },
        },
      },
      '/apps/{id}/federated': {
        post: {
          tags: ['Federated credentials'],
          summary: 'Add a federated credential',
          description: 'Issuer must be `https://` and on the allowlist (`FEDERATED_ALLOWED_ISSUERS`). No wildcards, max 20 per app.',
          parameters: [P.id],
          requestBody: { required: true, content: json(ref('NewFederated')) },
          responses: { 200: ok('Created', ref('Federated')), ...writeErrors },
        },
      },
      '/apps/{id}/federated/{ficId}': {
        patch: {
          tags: ['Federated credentials'],
          summary: 'Update a federated credential (the name can\'t change)',
          parameters: [P.id, P.ficId],
          requestBody: { required: true, content: json(ref('UpdateFederated')) },
          responses: { 200: ok('Updated'), ...writeErrors },
        },
        delete: {
          tags: ['Federated credentials'],
          summary: 'Delete a federated credential',
          parameters: [P.id, P.ficId],
          responses: { 200: ok('Deleted'), ...writeErrors },
        },
      },
      '/apps/{id}/permissions': {
        get: {
          tags: ['API permissions'],
          summary: 'Requested permissions and consent status',
          parameters: [P.id],
          responses: { 200: ok('Permissions', ref('PermissionList')), ...appErrors },
        },
        post: {
          tags: ['API permissions'],
          summary: 'Request API permissions',
          description: 'Only **requests** them; an admin still has to grant consent. High-risk permissions are logged.',
          parameters: [P.id],
          requestBody: { required: true, content: json(ref('NewPermissions')) },
          responses: { 200: ok('Added', { type: 'object', properties: { ok: { type: 'boolean' }, added: { type: 'integer' } } }), ...writeErrors },
        },
      },
      '/apps/{id}/permissions/{resourceAppId}/{type}/{permId}': {
        delete: {
          tags: ['API permissions'],
          summary: 'Remove a requested permission (does not revoke consent)',
          parameters: [P.id, P.resourceAppId,
            { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['Scope', 'Role'] }, description: '`Scope` = delegated, `Role` = application' },
            P.permId],
          responses: { 200: ok('Removed'), ...writeErrors },
        },
      },
      '/apps/{id}/owners': {
        post: {
          tags: ['Owners'],
          summary: 'Add an owner',
          description: 'Users only; guests are blocked unless `ALLOW_GUEST_OWNERS=true`.',
          parameters: [P.id],
          requestBody: { required: true, content: json({ type: 'object', required: ['userId'], properties: { userId: { ...guid, description: 'Object ID of the user' } } }) },
          responses: { 200: ok('Added'), ...writeErrors },
        },
      },
      '/apps/{id}/owners/{ownerId}': {
        delete: {
          tags: ['Owners'],
          summary: 'Remove an owner (the last owner can\'t be removed)',
          parameters: [P.id, P.ownerId],
          responses: { 200: ok('Removed', { type: 'object', properties: { ok: { type: 'boolean' }, removedSelf: { type: 'boolean' } } }), ...writeErrors },
        },
      },
      '/users': {
        get: {
          tags: ['Directory'],
          summary: 'Search users (name, UPN or mail prefix; or a full UPN / object ID)',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2, maxLength: 64 } }],
          responses: { 200: ok('Up to 15 users', { type: 'array', items: ref('Owner') }), 401: err('Not signed in') },
        },
      },
      '/api-catalog': {
        get: {
          tags: ['Directory'],
          summary: 'Search APIs (service principals) by name, or look one up by app ID',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 64 } }],
          responses: {
            200: ok('Matching APIs', { type: 'array', items: { type: 'object', properties: { appId: guid, displayName: { type: 'string' }, type: { type: 'string' } } } }),
            401: err('Not signed in'),
          },
        },
      },
      '/api-catalog/{appId}': {
        get: {
          tags: ['Directory'],
          summary: 'Scopes and app roles an API offers',
          parameters: [P.apiAppId],
          responses: { 200: ok('Catalog', ref('Catalog')), 400: err('Invalid API id'), 404: err('API not found in this tenant') },
        },
      },
    },
    components: {
      schemas: {
        Ok: { type: 'object', properties: { ok: { type: 'boolean', example: true } } },
        Error: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' } } },
        Reason: { type: 'object', properties: { reason: { type: 'string', maxLength: 200, description: 'Optional, written to the audit log' } } },
        DisableResult: { type: 'object', properties: { ok: { type: 'boolean' }, alreadyDisabled: { type: 'boolean' } } },
        EnableResult: { type: 'object', properties: { ok: { type: 'boolean' }, alreadyEnabled: { type: 'boolean' } } },
        Me: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            username: { type: 'string' },
            oid: guid,
            role: { type: 'string', enum: ['member', 'superadmin'] },
            hasAppAdminRole: { type: 'boolean', description: 'An active Application Administrator, Cloud Application Administrator or Global Administrator role was in the `wids` claim at sign-in' },
            maxSecretMonths: { type: 'integer', example: maxSecretMonths },
          },
        },
        Secret: {
          type: 'object',
          properties: {
            keyId: guid, displayName: { type: 'string' }, hint: { type: 'string' },
            startDateTime: { type: 'string', format: 'date-time' }, endDateTime: { type: 'string', format: 'date-time' },
          },
        },
        Certificate: {
          type: 'object',
          properties: {
            keyId: guid, displayName: { type: 'string' }, type: { type: 'string' }, usage: { type: 'string' },
            thumbprint: { type: 'string', nullable: true },
            startDateTime: { type: 'string', format: 'date-time' }, endDateTime: { type: 'string', format: 'date-time' },
          },
        },
        App: {
          type: 'object',
          properties: {
            id: { ...guid, description: 'Object ID' },
            appId: { ...guid, description: 'Application (client) ID' },
            displayName: { type: 'string' },
            createdDateTime: { type: 'string', format: 'date-time' },
            signInAudience: { type: 'string' },
            signInEnabled: { type: 'boolean', nullable: true, description: 'Enterprise app sign-in setting; null if there is no service principal or it could not be read' },
            disabledByMicrosoft: { type: 'string', nullable: true },
            deactivated: { type: 'boolean', nullable: true, description: 'App registration "Deactivated"; null if unknown (Graph beta unavailable)' },
            disabled: { type: 'boolean' },
            secrets: { type: 'array', items: ref('Secret') },
            certificates: { type: 'array', items: ref('Certificate') },
          },
        },
        AppDetail: {
          allOf: [ref('App'), {
            type: 'object',
            properties: {
              owners: { type: 'array', items: ref('Owner') },
              federated: { type: 'array', items: ref('Federated') },
              privileged: { type: 'array', nullable: true, items: { type: 'string' }, description: 'High-risk reasons; [] = not privileged; null = could not check' },
              privilegedMode: { type: 'string', enum: ['block', 'warn'] },
            },
          }],
        },
        Owner: {
          type: 'object',
          properties: {
            id: guid, displayName: { type: 'string' },
            userPrincipalName: { type: 'string', nullable: true }, mail: { type: 'string', nullable: true },
            type: { type: 'string', example: 'user' },
          },
        },
        NewSecret: {
          type: 'object',
          required: ['months'],
          properties: {
            displayName: { type: 'string', maxLength: 100, example: 'Pipeline secret' },
            months: { type: 'integer', minimum: 1, maximum: maxSecretMonths, example: 6 },
            replaceKeyId: { ...guid, description: 'Optional: existing secret to delete right after the new one is created' },
          },
        },
        CreatedSecret: {
          type: 'object',
          properties: {
            keyId: guid, displayName: { type: 'string' }, hint: { type: 'string' },
            endDateTime: { type: 'string', format: 'date-time' },
            secretText: { type: 'string', description: 'The secret value. Shown only once.' },
            removedKeyId: { ...guid, nullable: true },
          },
        },
        NewCertificate: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', format: 'byte', description: 'Base64 of the .cer / .crt (DER) or .pem file. Public certificate only.' },
            displayName: { type: 'string', maxLength: 100 },
          },
        },
        UploadedCertificate: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, thumbprint: { type: 'string' }, subject: { type: 'string' },
            validFrom: { type: 'string', format: 'date-time' }, validTo: { type: 'string', format: 'date-time' },
          },
        },
        Federated: {
          type: 'object',
          properties: {
            id: guid, name: { type: 'string' }, issuer: { type: 'string' }, subject: { type: 'string' },
            audiences: { type: 'array', items: { type: 'string' } }, description: { type: 'string', nullable: true },
          },
        },
        UpdateFederated: {
          type: 'object',
          required: ['issuer', 'subject'],
          properties: {
            issuer: { type: 'string', example: 'https://token.actions.githubusercontent.com' },
            subject: { type: 'string', example: 'repo:contoso/payroll:environment:prod' },
            audience: { type: 'string', default: 'api://AzureADTokenExchange' },
            description: { type: 'string', maxLength: 600 },
          },
        },
        NewFederated: {
          allOf: [{
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$', example: 'github-prod' } },
          }, ref('UpdateFederated')],
        },
        Permission: {
          type: 'object',
          properties: {
            resourceAppId: guid, resourceName: { type: 'string' }, id: guid,
            type: { type: 'string', enum: ['Scope', 'Role'] }, value: { type: 'string' }, displayName: { type: 'string', nullable: true },
            adminConsentRequired: { type: 'boolean', nullable: true }, highRisk: { type: 'boolean' },
            status: { type: 'string', enum: ['granted', 'user_consent', 'not_granted', 'unknown'] },
          },
        },
        PermissionList: {
          type: 'object',
          properties: { permissions: { type: 'array', items: ref('Permission') }, consentUrl: { type: 'string', format: 'uri' } },
        },
        NewPermissions: {
          type: 'object',
          required: ['resourceAppId', 'permissions'],
          properties: {
            resourceAppId: { ...guid, example: '00000003-0000-0000-c000-000000000000' },
            permissions: {
              type: 'array', minItems: 1, maxItems: 100,
              items: { type: 'object', required: ['id', 'type'], properties: { id: guid, type: { type: 'string', enum: ['Scope', 'Role'] } } },
            },
          },
        },
        CatalogItem: {
          type: 'object',
          properties: {
            id: guid, value: { type: 'string' }, displayName: { type: 'string' }, description: { type: 'string' },
            adminConsentRequired: { type: 'boolean' }, highRisk: { type: 'boolean' },
          },
        },
        Catalog: {
          type: 'object',
          properties: {
            appId: guid, displayName: { type: 'string' },
            scopes: { type: 'array', items: ref('CatalogItem') },
            roles: { type: 'array', items: ref('CatalogItem') },
          },
        },
      },
    },
  };
}

module.exports = { buildSpec };
