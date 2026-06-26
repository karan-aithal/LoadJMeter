'use strict';

const VALID_SCENARIOS = new Set(['base', 'fast', 'slow', 'cpu-heavy']);
const DURATION_RE     = /^[1-9][0-9]*(s|m|h)$/;

function toSeconds(d) {
  if (!d) return 0;
  const n = parseInt(d, 10);
  if (d.endsWith('h')) return n * 3600;
  if (d.endsWith('m')) return n * 60;
  return n;
}

module.exports = function validateTestConfig(req, res, next) {
  const { scenario, vus, duration, rampUp, rampDown } = req.body;
  const MAX_VUS      = parseInt(process.env.MAX_VUS      || '500',  10);
  const MAX_DURATION = parseInt(process.env.MAX_DURATION_S || '3600', 10);
  const errors = [];

  if (!VALID_SCENARIOS.has(scenario)) {
    errors.push(`scenario must be one of: ${[...VALID_SCENARIOS].join(', ')}`);
  }

  const vusNum = parseInt(vus, 10);
  if (!Number.isInteger(vusNum) || vusNum < 1 || vusNum > MAX_VUS) {
    errors.push(`vus must be an integer 1–${MAX_VUS}`);
  }

  if (!DURATION_RE.test(duration)) {
    errors.push('duration must match [0-9]+(s|m|h), e.g. 30s, 5m, 1h');
  } else if (toSeconds(duration) > MAX_DURATION) {
    errors.push(`duration exceeds maximum of ${MAX_DURATION}s`);
  }

  if (rampUp   && !DURATION_RE.test(rampUp))   errors.push('rampUp must match [0-9]+(s|m|h)');
  if (rampDown && !DURATION_RE.test(rampDown)) errors.push('rampDown must match [0-9]+(s|m|h)');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  req.body.vus = vusNum;
  next();
};
