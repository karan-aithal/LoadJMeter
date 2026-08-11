// k6 threshold definitions — tied to SLOs in docs/slo.md
// Import this into any k6 script that needs SLO enforcement.

// Single source of truth for the SUT's default URL. Override per-run with
// SUT_URL env var (docker-compose sets SUT_PORT via .env).
export const SUT_URL = __ENV.SUT_URL || 'http://sut:3000';

export const thresholds = {
  // Error rate < 1% across all requests — abort early if breaching
  http_req_failed: [
    { threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '10s' },
  ],

  // Per-endpoint p95 latency (name tag set on each request)
  'http_req_duration{name:fast}':      [{ threshold: 'p(95)<50' }],
  'http_req_duration{name:slow}':      [{ threshold: 'p(95)<400' }],
  'http_req_duration{name:cpu-heavy}': [{ threshold: 'p(95)<2000' }],

  // Overall p99 safety net — abort if catastrophically slow
  http_req_duration: [
    { threshold: 'p(99)<5000', abortOnFail: true, delayAbortEval: '10s' },
  ],
};
