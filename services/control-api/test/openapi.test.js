'use strict';

// Guards the API contract against drift: every route must be documented, every $ref must resolve,
// and docs/api-spec/openapi.yaml must equal the code spec (regenerate with `npm run spec:yaml`).
jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer');
jest.mock('../src/db/migrate', () => ({ runMigrations: jest.fn().mockResolvedValue() }));
jest.mock('../src/db/client',  () => ({ query: jest.fn(), connect: jest.fn() }));

process.env.JWT_SECRET = 'test-secret-minimum-32-chars-long!!';
process.env.API_KEY    = 'test-api-key';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { app }  = require('../src/index');
const { spec } = require('../src/openapi/generate');

// Express 4: walk the router stack. Mount paths come from the layer regexp, e.g. /^\/ops\/?(?=\/|$)/i
const mountOf = (layer) => layer.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
function collect(stack, prefix = '', out = new Set()) {
  for (const layer of stack) {
    if (layer.route) {
      const p = (prefix + layer.route.path).replace(/\/$/, '') || '/';
      for (const m of Object.keys(layer.route.methods)) out.add(`${m} ${p.replace(/:(\w+)/g, '{$1}')}`);
    } else if (layer.name === 'router') {
      collect(layer.handle.stack, prefix + mountOf(layer), out);
    }
  }
  return out;
}
const NOT_API = new Set(['get /api-spec.json']); // the spec itself (/api-docs is middleware, not a route)

describe('OpenAPI spec', () => {
  it('documents every route the app serves, and nothing that does not exist', () => {
    const served = [...collect(app._router.stack)].filter((r) => !NOT_API.has(r));
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`));
    expect(served.length).toBeGreaterThan(10); // guards against the introspection silently finding nothing
    expect(documented.sort()).toEqual(served.sort());
  });

  it('every $ref resolves to a component schema', () => {
    const names = new Set(Object.keys(spec.components.schemas));
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(5);
    expect(refs.filter((r) => !names.has(r))).toEqual([]);
  });

  it('every operation has responses and uses only declared security schemes and tags', () => {
    const schemes = new Set(Object.keys(spec.components.securitySchemes));
    const tags = new Set(spec.tags.map((t) => t.name));
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const [m, op] of Object.entries(ops)) {
        const at = `${m} ${p}`;
        expect({ at, responses: Object.keys(op.responses || {}).length > 0 }).toEqual({ at, responses: true });
        (op.tags || []).forEach((t) => expect({ at, tag: t, ok: tags.has(t) }).toEqual({ at, tag: t, ok: true }));
        (op.security || []).flatMap(Object.keys).forEach((s) => expect({ at, s, ok: schemes.has(s) }).toEqual({ at, s, ok: true }));
      }
    }
  });

  it('docs/api-spec/openapi.yaml is up to date with the code spec', () => {
    const file = path.resolve(__dirname, '../../../docs/api-spec/openapi.yaml');
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(spec)));
  });
});
