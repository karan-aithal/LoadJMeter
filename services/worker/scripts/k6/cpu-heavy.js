/**
 * cpu-heavy.js — focused load on /cpu-heavy only.
 * Use when isolating CPU-bound SLO behaviour.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const SUT_URL   = __ENV.SUT_URL   || 'http://sut:3000';
const VUS       = parseInt(__ENV.VUS       || '5');
const RAMP_UP   = __ENV.RAMP_UP   || '10s';
const STEADY    = __ENV.DURATION  || '60s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '10s';

export const options = {
  stages: [
    { duration: RAMP_UP,   target: VUS },
    { duration: STEADY,    target: VUS },
    { duration: RAMP_DOWN, target: 0   },
  ],
  thresholds: {
    http_req_failed:                       [{ threshold: 'rate<0.01', abortOnFail: true }],
    'http_req_duration{name:cpu-heavy}':   [{ threshold: 'p(95)<2000' }],
  },
};

export default function () {
  const res = http.get(`${SUT_URL}/cpu-heavy`, { tags: { name: 'cpu-heavy' } });
  check(res, { 'cpu-heavy 200': (r) => r.status === 200 });
  sleep(1);
}
