'use strict';

/* global SwaggerUIBundle */
window.addEventListener('load', () => {
  window.ui = SwaggerUIBundle({
    url: '/api-docs/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    validatorUrl: null, // don't send the spec to validator.swagger.io
    tryItOutEnabled: false, // "Try it out" must be clicked per operation
    displayRequestDuration: true,
    defaultModelsExpandDepth: 0,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    // Use the portal session cookie, and send the header the API requires on writes (CSRF check).
    requestInterceptor: (req) => {
      req.headers['X-Requested-With'] = 'fetch';
      req.credentials = 'same-origin';
      return req;
    },
  });
});
