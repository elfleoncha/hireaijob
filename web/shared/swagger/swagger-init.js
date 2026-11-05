'use strict';
window.addEventListener('DOMContentLoaded', function () {
  window.ui = SwaggerUIBundle({
    url: '/api/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    deepLinking: true,
    tryItOutEnabled: true,
    persistAuthorization: true,
    validatorUrl: null,
    displayRequestDuration: true,
    filter: false,
    docExpansion: "list",
    defaultModelsExpandDepth: -1
  });
});
