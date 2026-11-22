'use strict';

// Operator controls: runtime settings, reaper, queue/DLQ bulk actions, worker commands, infra chaos, audit log.
// Registered onto the ops router (kept separate from the read-only snapshot code in ops.js).
const producer = require('../queue/redis-producer');
const repo     = require('../db/repositories/test-run-repo');
const settings = require('../ops/settings');
const audit    = require('../ops/audit');
const workers  = require('../ops/workers');
const infra    = require('../ops/infra');
const reaper   = require('../queue/reaper');
const logger   = require('../logger');
const { launch } = require('../runs');

const PENDING = process.env.JOBS_PENDING_QUEUE || 'jobs:pending';
const DEAD    = process.env.JOBS_DL_QUEUE       || 'jobs:dead-letter';
const BULK_MAX = 200;

// the runtime `chaosEnabled` setting (default: CHAOS_ENABLED); read from Redis at most once a second
const chaosEnabled = async () => (await settings.fresh()).chaosEnabled;
const capabilities = () => { const on = settings.get().chaosEnabled; return { chaos: on, infraDriver: on && infra.driver() ? infra.driver().name : null }; };

// chaos-class actions are off until an operator enables chaos (CHAOS_ENABLED or the Chaos tab toggle)
async function chaosOnly(_req, res, next) {
  try {
    return (await chaosEnabled()) ? next() : res.status(403).json({ error: 'Chaos controls are disabled (enable them in the Chaos tab or set CHAOS_ENABLED=true)' });
  } catch (err) { return next(err); }
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('ops control error', { path: req.path, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = function mount(router, operator) {
  router.get('/settings', ...operator, wrap(async (_req, res) => {
    const values = await settings.load();
    res.json({ values, schema: settings.SCHEMA, capabilities: capabilities() });
  }));

  router.put('/settings', ...operator, wrap(async (req, res) => {
    const before = settings.get();
    try {
      const values = await settings.set(req.body);
      await audit.record(req, 'settings.update', { from: Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k]])), to: req.body });
      res.json({ values });
    } catch (err) { await audit.record(req, 'settings.update', { to: req.body, error: err.message }, 'rejected'); throw err; }
  }));

  router.post('/reaper/run', ...operator, wrap(async (req, res) => {
    const reaped = await reaper.reapOnce();
    await audit.record(req, 'reaper.run', { reaped });
    res.json({ reaped });
  }));

  // Purge pending: each job is cancelled like DELETE /tests/:id (tombstone first) so no run is left 'pending' forever.
  router.post('/queues/pending/purge', ...operator, wrap(async (req, res) => {
    const redis = producer.getClient();
    const raws = await redis.lrange(PENDING, 0, BULK_MAX - 1);
    let purged = 0;
    for (const raw of raws) {
      let job; try { job = JSON.parse(raw); } catch { job = null; }
      if (job && job.id) await producer.markCancelled(job.id);
      if ((await redis.lrem(PENDING, 1, raw)) === 1) { purged++; if (job && job.id) await repo.cancel(job.id).catch(() => null); }
    }
    await audit.record(req, 'queue.pending.purge', { purged });
    res.json({ purged });
  }));

  router.post('/queues/dlq/purge', ...operator, wrap(async (req, res) => {
    const redis = producer.getClient();
    const raws = await redis.lrange(DEAD, 0, BULK_MAX - 1);
    let purged = 0;
    for (const raw of raws) if ((await redis.lrem(DEAD, 1, raw)) === 1) purged++;
    await audit.record(req, 'queue.dlq.purge', { purged });
    res.json({ purged });
  }));

  router.post('/queues/dlq/requeue', ...operator, wrap(async (req, res) => {
    const redis = producer.getClient();
    const raws = await redis.lrange(DEAD, 0, BULK_MAX - 1);
    const runs = [];
    for (const raw of raws) {
      let job; try { job = JSON.parse(raw); } catch { continue; }
      if ((await redis.lrem(DEAD, 1, raw)) !== 1) continue;
      try { runs.push((await launch(job.config)).id); }
      catch (err) { await redis.rpush(DEAD, raw); logger.error('dlq bulk requeue failed', { id: job.id, error: err.message }); }
    }
    await audit.record(req, 'queue.dlq.requeue', { requeued: runs.length });
    res.json({ requeued: runs.length, runs });
  }));

  router.get('/workers', ...operator, wrap(async (_req, res) => {
    res.json({ workers: await workers.list(producer.getClient()), capabilities: capabilities() });
  }));

  router.post('/workers/:id/:cmd', ...operator, wrap(async (req, res) => {
    const { id, cmd } = req.params;
    if (!workers.COMMANDS.includes(cmd)) return res.status(400).json({ error: `Unknown command: ${cmd}` });
    if (workers.DESTRUCTIVE.has(cmd) && !(await chaosEnabled())) return chaosOnly(req, res);
    const redis = producer.getClient();
    if (id !== '*' && !(await workers.list(redis)).some((w) => w.workerId === id)) return res.status(404).json({ error: 'Unknown worker' });
    const args = {};
    if (cmd === 'partition') {
      args.seconds = Number.isInteger(req.body && req.body.seconds) ? req.body.seconds : 30;
      if (args.seconds < 5 || args.seconds > 300) return res.status(400).json({ error: 'seconds must be 5-300' });
    }
    const receivers = await workers.command(redis, id, cmd, args);
    await audit.record(req, `worker.${cmd}`, { target: id, ...args, receivers });
    res.json({ sent: cmd, target: id, receivers });
  }));

  router.get('/infra', ...operator, wrap(async (_req, res) => {
    await settings.fresh();
    const d = capabilities().infraDriver && infra.driver();
    res.json({ driver: d ? d.name : null, workers: d ? await d.list() : [] });
  }));

  router.post('/infra/:action', ...operator, chaosOnly, wrap(async (req, res) => {
    const { action } = req.params;
    const { target, seconds } = req.body || {};
    if (typeof target !== 'string' || !target) return res.status(400).json({ error: 'target required' });
    if (action === 'partition' && !(Number.isInteger(seconds) && seconds >= 5 && seconds <= 300)) return res.status(400).json({ error: 'seconds must be 5-300' });
    try {
      const result = await infra.run(action, target, { seconds });
      await audit.record(req, `infra.${action}`, { target, seconds });
      res.json({ ok: true, result });
    } catch (err) { await audit.record(req, `infra.${action}`, { target, error: err.message }, 'failed'); throw err; }
  }));

  router.get('/audit', ...operator, wrap(async (_req, res) => res.json({ entries: await audit.list(100) })));
};
module.exports.capabilities = capabilities;
