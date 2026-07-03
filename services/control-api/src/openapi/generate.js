'use strict';

const swaggerUi = require('swagger-ui-express');

// Spec is defined inline — avoids file-path issues in multi-stage Docker builds.
const spec = {
  openapi: '3.0.3',
  info: { title: 'Load Test Control API', version: '1.0.0',
    description: 'Control plane for the distributed load testing platform' },
  servers: [{ url: 'http://localhost:4000', description: 'Local' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      TestConfig: {
        type: 'object', required: ['scenario', 'vus', 'duration'],
        properties: {
          scenario: { type: 'string', enum: ['base', 'fast', 'slow', 'cpu-heavy'] },
          vus:      { type: 'integer', minimum: 1, maximum: 500 },
          duration: { type: 'string', pattern: '^[1-9][0-9]*(s|m|h)$', example: '30s' },
          rampUp:   { type: 'string', pattern: '^[1-9][0-9]*(s|m|h)$' },
          rampDown: { type: 'string', pattern: '^[1-9][0-9]*(s|m|h)$' },
          sutUrl:   { type: 'string', format: 'uri' },
        },
      },
      TestRun: {
        type: 'object',
        properties: {
          id:              { type: 'string', format: 'uuid' },
          idempotency_key: { type: 'string' },
          status:          { type: 'string', enum: ['pending','running','completed','failed','cancelled'] },
          config:          { $ref: '#/components/schemas/TestConfig' },
          verdict:         { type: 'string', enum: ['PASS','FAIL','INCONCLUSIVE'], nullable: true },
          created_at:      { type: 'string', format: 'date-time' },
          updated_at:      { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/auth/token': {
      post: {
        summary: 'Issue JWT', tags: ['Auth'],
        requestBody: { required: true, content: { 'application/json': {
          schema: { type: 'object', required: ['apiKey'],
            properties: { apiKey: { type: 'string' } } } } } },
        responses: {
          200: { description: 'JWT token', content: { 'application/json': {
            schema: { type: 'object', properties: { token: { type: 'string' } } } } } },
          401: { description: 'Invalid API key' },
        },
      },
    },
    '/tests': {
      post: {
        summary: 'Create test run', tags: ['Tests'],
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'header', name: 'Idempotency-Key', required: true,
          schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': {
          schema: { $ref: '#/components/schemas/TestConfig' } } } },
        responses: {
          201: { description: 'Created', content: { 'application/json': {
            schema: { $ref: '#/components/schemas/TestRun' } } } },
          200: { description: 'Idempotent return (key already used)' },
          400: { description: 'Validation error' },
          401: { description: 'Unauthorized' },
        },
      },
      get: {
        summary: 'List test runs', tags: ['Tests'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { in: 'query', name: 'page',  schema: { type: 'integer', default: 1 } },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: { 200: { description: 'Paginated list' }, 401: { description: 'Unauthorized' } },
      },
    },
    '/tests/{id}': {
      get: {
        summary: 'Get test run', tags: ['Tests'],
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Test run', content: { 'application/json': {
            schema: { $ref: '#/components/schemas/TestRun' } } } },
          404: { description: 'Not found' },
        },
      },
      delete: {
        summary: 'Cancel test run', tags: ['Tests'],
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Cancelled' },
          409: { description: 'Cannot cancel (already terminal)' },
          404: { description: 'Not found' },
        },
      },
    },
    '/tests/{id}/status': {
      patch: {
        summary: 'Internal worker status update', tags: ['Tests'],
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['pending','running','completed','failed','cancelled'] },
                  verdict: { type: 'string', enum: ['PASS','FAIL','INCONCLUSIVE'], nullable: true },
                  workerId: { type: 'string' },
                  errorMessage: { type: 'string', nullable: true },
                  startedAt: { type: 'string', format: 'date-time' },
                  completedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated test run' }, 404: { description: 'Not found' } },
      },
    },
    '/tests/{id}/heartbeat': {
      post: {
        summary: 'Internal worker heartbeat', tags: ['Tests'],
        security: [{ bearerAuth: [] }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  workerId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Heartbeat accepted' }, 404: { description: 'Not found' } },
      },
    },
  },
};

function setupOpenApi(app) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));
  app.get('/api-spec.json', (_req, res) => res.json(spec));
}

module.exports = { setupOpenApi, spec };
