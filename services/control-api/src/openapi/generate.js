'use strict';

const swaggerUi = require('swagger-ui-express');

// Single source of truth for the API contract. Served at /api-spec.json and /api-docs;
// docs/api-spec/openapi.yaml is generated from it (`npm run spec:yaml`).
// test/openapi.test.js fails if a route exists that is not documented here.
// Inline (not a file) — avoids file-path issues in multi-stage Docker builds.

const ref  = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const resp = (description, schema) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const idParam = { in: 'path', name: 'id', required: true, schema: { type: 'string' } };
const operator = [{ bearerAuth: [] }];
const worker   = [{ apiKeyAuth: [] }];
const U401 = resp('Unauthorized');
const F403 = resp('Forbidden: wrong role for this route');
const E500 = resp('Internal server error', ref('Error'));
const FENCED = resp('Fenced: the run is terminal or the writer\'s epoch is stale. The worker must stop acting on this job.', ref('Fenced'));
const DURATION = { type: 'string', pattern: '^[1-9][0-9]*(s|m|h)$' };
const STATUS   = ['pending', 'running', 'completed', 'failed', 'cancelled'];

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Load Test Control API', version: '1.1.0',
    description:
      'Control plane for the distributed load testing platform.\n\n' +
      '**Roles.** UI users exchange the API key for a JWT (role `operator`) and may call the operator routes. ' +
      'Workers authenticate with the `x-api-key` header (role `worker`) and may call only the worker routes ' +
      '(`PATCH /tests/{id}/status`, `POST /tests/{id}/heartbeat`). The other role gets 403.\n\n' +
      '**Fencing.** `test_runs.epoch` is a fencing token. A worker running attempt *n* sends epoch *n* on every write; ' +
      'the API answers 409 `fenced` once the reaper or a newer attempt owns the run.',
  },
  servers: [{ url: 'http://localhost:4000', description: 'Local' }],
  tags: [
    { name: 'Auth' }, { name: 'Tests', description: 'Operator routes' },
    { name: 'Worker', description: 'Internal, worker-only (x-api-key)' },
    { name: 'Ops', description: 'Dashboard: queues, dead-letter, live feed, chaos results (operator)' },
    { name: 'Health' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } } },
      Fenced: {
        type: 'object',
        properties: {
          error:  { type: 'string', enum: ['fenced'] },
          status: { type: 'string', enum: STATUS, description: 'Current status of the run' },
          epoch:  { type: 'integer', description: 'Current epoch of the run (the writer\'s must be >= this)' },
        },
      },
      TestConfig: {
        type: 'object', required: ['scenario', 'vus', 'duration'],
        properties: {
          scenario: { type: 'string', enum: ['base', 'fast', 'slow', 'cpu-heavy'] },
          vus:      { type: 'integer', minimum: 1, maximum: 500, description: 'Capped by MAX_VUS' },
          duration: { ...DURATION, example: '30s', description: 'Capped by MAX_DURATION_S' },
          rampUp:   DURATION,
          rampDown: DURATION,
          sutUrl:   { type: 'string', format: 'uri' },
        },
      },
      TestRun: {
        type: 'object',
        properties: {
          id:              { type: 'string', format: 'uuid' },
          idempotency_key: { type: 'string' },
          status:          { type: 'string', enum: STATUS },
          config:          ref('TestConfig'),
          verdict:         { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'], nullable: true },
          worker_id:       { type: 'string', nullable: true },
          error_message:   { type: 'string', nullable: true },
          epoch:           { type: 'integer', description: 'Fencing token, only ever increases' },
          created_at:      { type: 'string', format: 'date-time' },
          updated_at:      { type: 'string', format: 'date-time', description: 'Doubles as the worker heartbeat timestamp' },
          started_at:      { type: 'string', format: 'date-time', nullable: true },
          completed_at:    { type: 'string', format: 'date-time', nullable: true },
        },
      },
      TestRunList: {
        type: 'object',
        properties: {
          items: { type: 'array', items: ref('TestRun') },
          total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' },
        },
      },
      QueueItem: {
        type: 'object',
        description: 'A parsed Redis queue entry. Unparseable entries come back as `{id: null, raw}`.',
        properties: {
          id:               { type: 'string', nullable: true },
          attempt:          { type: 'integer' },
          scenario:         { type: 'string', nullable: true },
          createdAt:        { type: 'string', format: 'date-time', nullable: true },
          lastError:        { type: 'string', nullable: true },
          deadLetterReason: { type: 'string', nullable: true },
          deadLetteredAt:   { type: 'string', format: 'date-time', nullable: true },
          raw:              { type: 'string', description: 'Only for unparseable entries' },
        },
      },
      Queue: {
        type: 'object',
        properties: {
          length: { type: 'integer', description: 'Total entries in the Redis list' },
          items:  { type: 'array', items: ref('QueueItem'), description: 'First 50 entries' },
        },
      },
      OpsSnapshot: {
        type: 'object',
        properties: {
          at: { type: 'string', format: 'date-time' },
          queues: { type: 'object', properties: { pending: ref('Queue'), processing: ref('Queue'), dlq: ref('Queue') } },
          workers: {
            type: 'array', description: 'Workers with a running job (derived from running rows)',
            items: { type: 'object', properties: {
              workerId: { type: 'string' }, runId: { type: 'string' }, epoch: { type: 'integer' },
              lastHeartbeat: { type: 'string', format: 'date-time' } } },
          },
          active:  { type: 'integer', description: 'Runs that are pending or running' },
          recent:  { type: 'array', items: ref('TestRun'), description: '20 newest runs' },
          counters: { type: 'object', description: 'In-process, reset on API restart', properties: {
            reaped_total: { type: 'integer' }, fenced_writes_total: { type: 'integer' } } },
        },
      },
      Stats: {
        type: 'object', description: 'Nearest-rank percentiles',
        properties: { min: { type: 'number', nullable: true }, p50: { type: 'number', nullable: true },
                      p95: { type: 'number', nullable: true }, max: { type: 'number', nullable: true } },
      },
      ChaosResults: {
        type: 'object',
        properties: {
          runs: { type: 'array', items: { type: 'object', additionalProperties: true,
            description: 'One result file: the script\'s own fields (result, mttr_seconds, ...) plus `file` and `kind`.',
            properties: { file: { type: 'string' }, kind: { type: 'string' }, result: { type: 'string', enum: ['PASS', 'FAIL'] } } } },
          summary: { type: 'object', nullable: true, description: 'null when the results directory is missing or empty', properties: {
            runs: { type: 'integer' }, passed: { type: 'integer' }, lost_jobs: { type: 'integer' },
            duplicate_completions: { type: 'integer' },
            mttr_seconds: ref('Stats'), completion_seconds: ref('Stats'),
            git_shas: { type: 'array', items: { type: 'string' }, description: 'More than one means the runs mix code versions' } } },
          dir: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/healthz': { get: { summary: 'Liveness', tags: ['Health'], responses: { 200: resp('Alive') } } },
    '/readyz':  { get: { summary: 'Readiness (checks the database)', tags: ['Health'],
      responses: { 200: resp('Ready'), 503: resp('Database unreachable') } } },
    '/metrics': { get: { summary: 'Prometheus metrics (reaped and fenced-write counters)', tags: ['Health'],
      responses: { 200: { description: 'Prometheus text format', content: { 'text/plain': { schema: { type: 'string' } } } } } } },

    '/auth/token': {
      post: {
        summary: 'Issue JWT (role operator)', tags: ['Auth'],
        requestBody: { required: true, content: json({ type: 'object', required: ['apiKey'], properties: { apiKey: { type: 'string' } } }) },
        responses: {
          200: resp('JWT token', { type: 'object', properties: { token: { type: 'string' } } }),
          401: resp('Invalid API key'), 500: resp('Server misconfiguration'),
        },
      },
    },

    '/tests': {
      post: {
        summary: 'Create test run', tags: ['Tests'], security: operator,
        parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', maxLength: 255 } }],
        requestBody: { required: true, content: json(ref('TestConfig')) },
        responses: {
          201: resp('Created and enqueued', ref('TestRun')),
          200: resp('Idempotent return (key already used)', ref('TestRun')),
          400: resp('Validation error (or missing Idempotency-Key)'), 401: U401, 500: E500,
        },
      },
      get: {
        summary: 'List test runs (newest first)', tags: ['Tests'], security: operator,
        parameters: [
          { in: 'query', name: 'page',  schema: { type: 'integer', default: 1 } },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: { 200: resp('Paginated list', ref('TestRunList')), 401: U401 },
      },
    },
    '/tests/{id}': {
      get: {
        summary: 'Get test run', tags: ['Tests'], security: operator, parameters: [idParam],
        responses: { 200: resp('Test run', ref('TestRun')), 401: U401, 404: resp('Not found') },
      },
      delete: {
        summary: 'Cancel test run', tags: ['Tests'], security: operator, parameters: [idParam],
        description: 'Sets a cancel tombstone and marks the run cancelled. A running worker learns of it when its next heartbeat gets 409.',
        responses: {
          200: resp('Cancelled', ref('TestRun')), 401: U401, 404: resp('Not found'),
          409: resp('Cannot cancel (already terminal, or it just finished)', ref('Error')),
        },
      },
    },
    '/tests/{id}/retry': {
      post: {
        summary: 'Re-run a finished run as a NEW run', tags: ['Tests'], security: operator, parameters: [idParam],
        description: 'Copies the config of a completed, failed or cancelled run into a new run (new id, epoch 0) and enqueues it. The original row is left untouched.',
        responses: {
          201: resp('New run', ref('TestRun')), 401: U401, 403: F403, 404: resp('Not found'),
          409: resp('Run is still pending or running', ref('Error')), 500: E500,
        },
      },
    },
    '/tests/{id}/status': {
      patch: {
        summary: 'Worker status update (fenced)', tags: ['Worker'], security: worker, parameters: [idParam],
        description: 'Applied only if the run is not terminal and `epoch` >= the row\'s epoch. `nextEpoch` (default: `epoch`) is stored, so a worker re-queueing its job passes epoch+1 to fence itself out.',
        requestBody: { required: true, content: json({
          type: 'object',
          properties: {
            status:       { type: 'string', enum: STATUS },
            verdict:      { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'], nullable: true },
            workerId:     { type: 'string' },
            errorMessage: { type: 'string', nullable: true },
            startedAt:    { type: 'string', format: 'date-time' },
            completedAt:  { type: 'string', format: 'date-time' },
            epoch:        { type: 'integer', description: 'The writer\'s fencing token (its attempt number)' },
            nextEpoch:    { type: 'integer' },
          },
        }) },
        responses: { 200: resp('Updated run', ref('TestRun')), 401: U401, 403: F403, 404: resp('Not found'), 409: FENCED },
      },
    },
    '/tests/{id}/heartbeat': {
      post: {
        summary: 'Worker heartbeat (fenced)', tags: ['Worker'], security: worker, parameters: [idParam],
        description: 'Bumps `updated_at`, which the reaper reads as liveness. A 409 means stop: cancel k6 and walk away.',
        requestBody: { required: false, content: json({
          type: 'object',
          properties: { workerId: { type: 'string' }, epoch: { type: 'integer' } },
        }) },
        responses: {
          200: resp('Heartbeat accepted', { type: 'object', properties: {
            status: { type: 'string', enum: ['ok'] }, id: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' } } }),
          401: U401, 403: F403, 404: resp('Not found'), 409: FENCED,
        },
      },
    },

    '/ops/queues': {
      get: {
        summary: 'Queue, worker and counter snapshot', tags: ['Ops'], security: operator,
        responses: { 200: resp('Snapshot (same payload as a stream event)', ref('OpsSnapshot')), 401: U401, 403: F403, 500: E500 },
      },
    },
    '/ops/stream': {
      get: {
        summary: 'Live snapshot feed (Server-Sent Events)', tags: ['Ops'], security: operator,
        description: 'Emits an `OpsSnapshot` as a `data:` frame every OPS_STREAM_MS (default 2000). On a snapshot error it emits an `event: failure` frame and keeps going. ' +
          'Browsers\' EventSource cannot set headers, so the JWT may be passed as `?token=` instead of the Authorization header.',
        parameters: [{ in: 'query', name: 'token', required: false, schema: { type: 'string' }, description: 'JWT, alternative to the Authorization header' }],
        responses: {
          200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          401: U401, 403: F403,
        },
      },
    },
    '/ops/dlq/{id}/requeue': {
      post: {
        summary: 'Requeue a dead-lettered job as a NEW run', tags: ['Ops'], security: operator, parameters: [idParam],
        description: '`id` is the job id in jobs:dead-letter. The entry is removed and its config launched as a new run (fresh retries); if the relaunch fails the entry is put back.',
        responses: {
          201: resp('New run', ref('TestRun')), 401: U401, 403: F403,
          404: resp('Not in the dead-letter queue'), 409: resp('Already handled by another request'), 500: E500,
        },
      },
    },
    '/ops/dlq/{id}': {
      delete: {
        summary: 'Purge one dead-letter entry', tags: ['Ops'], security: operator, parameters: [idParam],
        responses: {
          200: resp('Purged', { type: 'object', properties: { purged: { type: 'string' } } }),
          401: U401, 403: F403, 404: resp('Not in the dead-letter queue'), 500: E500,
        },
      },
    },
    '/ops/chaos': {
      get: {
        summary: 'Recorded chaos / recovery runs and their summary', tags: ['Ops'], security: operator,
        description: 'Read-only view of the JSON files in RESULTS_DIR (docs/benchmarks/results).',
        responses: { 200: resp('Runs and aggregate', ref('ChaosResults')), 401: U401, 403: F403 },
      },
    },
  },
};

function setupOpenApi(app) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));
  app.get('/api-spec.json', (_req, res) => res.json(spec));
}

module.exports = { setupOpenApi, spec };
