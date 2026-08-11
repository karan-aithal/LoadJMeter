/**
 * slow-endpoint.js — focused load on /slow only.
 * Use when isolating /slow SLO behaviour.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SUT_URL } from '../thresholds.js';

const VUS       = parseInt(__ENV.VUS       || '20');
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
    http_req_failed:                  [{ threshold: 'rate<0.01', abortOnFail: true }],
    'http_req_duration{name:slow}':   [{ threshold: 'p(95)<400' }],
  },
};

export default function () {
  const res = http.get(`${SUT_URL}/slow`, { tags: { name: 'slow' } });
  check(res, { 'slow 200': (r) => r.status === 200 });
  sleep(0.5);
}
