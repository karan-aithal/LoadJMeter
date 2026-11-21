'use strict';

// Regenerates docs/api-spec/openapi.yaml from the code spec (src/openapi/generate.js). Run: npm run spec:yaml
// test/openapi.test.js fails if the committed YAML differs from the spec, so run this after changing routes.
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spec } = require('../src/openapi/generate');

const OUT = path.resolve(__dirname, '../../../docs/api-spec/openapi.yaml');
const header = '# GENERATED from services/control-api/src/openapi/generate.js — do not edit by hand.\n' +
               '# Regenerate: (cd services/control-api && npm run spec:yaml)\n';

fs.writeFileSync(OUT, header + yaml.dump(spec, { lineWidth: 120, noRefs: true }));
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
