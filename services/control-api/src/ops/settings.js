'use strict';

// Runtime-tunable settings, shared with the workers through one Redis hash. Env vars are only the defaults.
// Writers validate here; readers (reaper, intake gate, workers) take whatever the hash holds, falling back to the default.
const producer = require('../queue/redis-producer');
const logger   = require('../logger');

const KEY = 'ops:settings';
const env = (name, d) => parseInt(process.env[name] || String(d), 10);

const SCHEMA = {
  reaperPaused:        { type: 'bool', def: false,                              desc: 'Stop the reaper from requeueing stale jobs' },
  reaperStaleMs:       { type: 'int', min: 5000, max: 600000, def: env('REAPER_STALE_MS', 20000),       desc: 'Silence before a running job counts as lost' },
  reaperIntervalMs:    { type: 'int', min: 1000, max: 60000,  def: env('REAPER_INTERVAL_MS', 5000),     desc: 'How often the reaper scans jobs:processing' },
  maxRetries:          { type: 'int', min: 1,    max: 10,     def: env('MAX_RETRIES', 3),              desc: 'Attempts before a job is dead-lettered' },
  heartbeatIntervalMs: { type: 'int', min: 1000, max: 30000,  def: env('HEARTBEAT_INTERVAL_MS', 5000), desc: 'Worker heartbeat period (applies from the next job)' },
  intakePaused:        { type: 'bool', def: false,                              desc: 'Reject new POST /tests with 503' },
  // gates crash/drain/partition and infra actions; CHAOS_ENABLED is only the default, an operator can flip it from the UI
  get chaosEnabled() { return { type: 'bool', def: process.env.CHAOS_ENABLED === 'true', desc: 'Unlock worker crash/drain/partition and infra chaos' }; },
};

const defaults = () => Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.def]));
let cache = defaults();
let loadedAt = 0;

function coerce(key, raw) {
  const s = SCHEMA[key];
  if (s.type === 'bool') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw Object.assign(new Error(`${key} must be true or false`), { status: 400 });
  }
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < s.min || n > s.max) {
    throw Object.assign(new Error(`${key} must be an integer between ${s.min} and ${s.max}`), { status: 400 });
  }
  return n;
}

const get = () => cache;

async function load(redis = producer.getClient()) {
  try {
    const h = await redis.hgetall(KEY);
    const next = defaults();
    for (const k of Object.keys(SCHEMA)) {
      if (h && h[k] !== undefined) { try { next[k] = coerce(k, h[k]); } catch { /* bad stored value: keep default */ } }
    }
    cache = next; loadedAt = Date.now();
  } catch (err) {
    logger.warn('settings load failed, using cached values', { error: err.message });
  }
  return cache;
}

// cheap read for hot paths: at most one Redis call per second
const fresh = async () => (Date.now() - loadedAt > 1000 ? load() : cache);

async function set(patch, redis = producer.getClient()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw Object.assign(new Error('Body must be an object of settings'), { status: 400 });
  }
  const next = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!SCHEMA[k]) throw Object.assign(new Error(`Unknown setting: ${k}`), { status: 400 });
    next[k] = coerce(k, v);
  }
  await load(redis);
  const merged = { ...cache, ...next };
  // a reaper that fires before a healthy worker's second heartbeat would requeue live jobs
  if (merged.reaperStaleMs < merged.heartbeatIntervalMs * 2) {
    throw Object.assign(new Error('reaperStaleMs must be at least 2x heartbeatIntervalMs'), { status: 400 });
  }
  await redis.hset(KEY, Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])));
  cache = merged; loadedAt = Date.now();
  return cache;
}

module.exports = { SCHEMA, KEY, get, load, fresh, set };
