/**
 * base-scenario.js — hits all 3 SUT endpoints with a realistic profile.
 * Env vars (all optional, sensible defaults):
 *   SUT_URL      target base URL   (default: http://sut:3000)
 *   VUS          peak virtual users (default: 10)
 *   RAMP_UP      ramp-up duration   (default: 10s)
 *   DURATION     steady-state       (default: 30s)
 *   RAMP_DOWN    ramp-down duration (default: 10s)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { thresholds, SUT_URL } from '../thresholds.js';

const VUS       = parseInt(__ENV.VUS       || '10');
const RAMP_UP   = __ENV.RAMP_UP   || '10s';
const STEADY    = __ENV.DURATION  || '30s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '10s';

export const options = {
  stages: [
    { duration: RAMP_UP,   target: VUS },   // ramp up
    { duration: STEADY,    target: VUS },   // steady state
    { duration: RAMP_DOWN, target: 0   },   // ramp down
  ],
  thresholds,
};

export default function () {
  // /fast — every iteration
  const fastRes = http.get(`${SUT_URL}/fast`, {
    tags: { name: 'fast' },
  });
  check(fastRes, { 'fast 200': (r) => r.status === 200 });

  // /slow — every 3rd iteration (lighter weight)
  if (__ITER % 3 === 0) {
    const slowRes = http.get(`${SUT_URL}/slow`, {
      tags: { name: 'slow' },
    });
    check(slowRes, { 'slow 200': (r) => r.status === 200 });
  }

  // /cpu-heavy — every 5th iteration (most expensive)
  if (__ITER % 5 === 0) {
    const cpuRes = http.get(`${SUT_URL}/cpu-heavy`, {
      tags: { name: 'cpu-heavy' },
    });
    check(cpuRes, { 'cpu-heavy 200': (r) => r.status === 200 });
  }

  sleep(1);
}
