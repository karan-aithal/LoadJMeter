'use strict';

// Operator dashboard API: queue inspection, DLQ actions, SSE live feed, chaos/bench results.
const fs     = require('fs');
const path   = require('path');
const router = require('express').Router();
const repo     = require('../db/repositories/test-run-repo');
const producer = require('../queue/redis-producer');
const metrics  = require('../metrics');
const auth     = require('../middleware/auth');
const logger   = require('../logger');
const { launch } = require('../runs');
const settings = require('../ops/settings');
const workerFleet = require('../ops/workers');
const reaper   = require('../queue/reaper');
const control  = require('./ops-control');

const PENDING    = process.env.JOBS_PENDING_QUEUE    || 'jobs:pending';
const PROCESSING = process.env.JOBS_PROCESSING_QUEUE || 'jobs:processing';
const DEAD       = process.env.JOBS_DL_QUEUE         || 'jobs:dead-letter';
const ITEMS      = 50;
const STREAM_MS  = parseInt(process.env.OPS_STREAM_MS || '2000', 10);
const clampMs    = (v) => Math.min(60000, Math.max(500, parseInt(v, 10) || STREAM_MS)); // per-connection ?ms=
const RESULTS_DIR = process.env.RESULTS_DIR || path.resolve(__dirname, '../../../../docs/benchmarks/results');

const operator = [auth, auth.requireRole('operator')];

// EventSource cannot send an Authorization header, so /stream also accepts the JWT as ?token=.
// ponytail: JWT in a query string can land in access logs; switch to a short-lived stream ticket if that matters.
function tokenFromQuery(req, _res, next) {
  if (req.query.token && !req.headers.authorization) req.headers.authorization = `Bearer ${req.query.token}`;
  next();
}

function describe(raw) {
  try {
    const j = JSON.parse(raw);
    return {
      id: j.id, attempt: Number.isInteger(j.attempt) ? j.attempt : 0, scenario: j.config && j.config.scenario,
      createdAt: j.createdAt, lastError: j.lastError || null,
      deadLetterReason: j.deadLetterReason || null, deadLetteredAt: j.deadLetteredAt || null,
    };
  } catch { return { id: null, raw: String(raw).slice(0, 200) }; }
}

async function snapshot() {
  const redis = producer.getClient();
  const [pl, prl, dl, pend, proc, dead, active, recent, fleet, cfg] = await Promise.all([
    redis.llen(PENDING), redis.llen(PROCESSING), redis.llen(DEAD),
    redis.lrange(PENDING, 0, ITEMS - 1), redis.lrange(PROCESSING, 0, ITEMS - 1), redis.lrange(DEAD, 0, ITEMS - 1),
    repo.listActive(), repo.list({ page: 1, limit: 20 }),
    workerFleet.list(redis).catch(() => []), settings.load(redis),
  ]);
  const workers = {};
  for (const r of active) {
    if (r.status === 'running' && r.worker_id) {
      workers[r.worker_id] = { workerId: r.worker_id, runId: r.id, epoch: r.epoch, lastHeartbeat: r.updated_at };
    }
  }
  return {
    at: new Date().toISOString(),
    queues: {
      pending:    { length: pl,  items: pend.map(describe) },
      processing: { length: prl, items: proc.map(describe) },
      dlq:        { length: dl,  items: dead.map(describe) },
    },
    workers: Object.values(workers),
    fleet,
    settings: cfg,
    reaper: reaper.status,
    capabilities: control.capabilities(),
    active: active.length,
    recent: recent.items,
    counters: metrics.snapshot(),
  };
}

// GET /ops/queues — one-shot snapshot (same payload as a stream event)
router.get('/queues', ...operator, async (_req, res) => {
  try { res.json(await snapshot()); } catch (err) {
    logger.error('GET /ops/queues error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/stream — SSE: a snapshot every STREAM_MS
router.get('/stream', tokenFromQuery, ...operator, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const push = async () => {
    try { res.write(`data: ${JSON.stringify(await snapshot())}\n\n`); } catch (err) {
      res.write(`event: failure\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };
  const ms = clampMs(req.query.ms);
  const timer = setInterval(push, ms);
  req.on('close', () => clearInterval(timer));
  push();
});

async function findDlq(id) {
  const raws = await producer.getClient().lrange(DEAD, 0, -1);
  for (const raw of raws) {
    try { const job = JSON.parse(raw); if (job.id === id) return { raw, job }; } catch { /* skip bad entry */ }
  }
  return null;
}

// POST /ops/dlq/:id/requeue — remove from DLQ and run its config as a NEW run (fresh retries, no epoch games)
router.post('/dlq/:id/requeue', ...operator, async (req, res) => {
  try {
    const hit = await findDlq(req.params.id);
    if (!hit) return res.status(404).json({ error: 'Not in dead-letter queue' });
    const redis = producer.getClient();
    if ((await redis.lrem(DEAD, 1, hit.raw)) !== 1) return res.status(409).json({ error: 'Already handled' });
    try {
      const run = await launch(hit.job.config);
      logger.info('dlq_requeued', { id: hit.job.id, newId: run.id });
      return res.status(201).json(run);
    } catch (err) {
      await redis.rpush(DEAD, hit.raw); // never lose a DLQ entry because the relaunch failed
      throw err;
    }
  } catch (err) {
    logger.error('DLQ requeue error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /ops/dlq/:id — purge one dead-letter entry
router.delete('/dlq/:id', ...operator, async (req, res) => {
  try {
    const hit = await findDlq(req.params.id);
    if (!hit || (await producer.getClient().lrem(DEAD, 1, hit.raw)) !== 1) {
      return res.status(404).json({ error: 'Not in dead-letter queue' });
    }
    logger.info('dlq_purged', { id: hit.job.id });
    return res.json({ purged: hit.job.id });
  } catch (err) {
    logger.error('DLQ purge error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// nearest-rank percentile, same method as infra/scripts/chaos-summary.sh
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function stats(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return { min: v[0] ?? null, p50: pct(v, 50), p95: pct(v, 95), max: v[v.length - 1] ?? null };
}

function loadChaos(dir = RESULTS_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return { runs: [], summary: null, dir }; }
  const runs = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      runs.push({ file: f, kind: f.replace(/-\d+\.json$/, ''), ...r });
    } catch { /* ignore unreadable result file */ }
  }
  const lost = (r) => r.left_in_redis === true || r.in_dead_letter === true || r.final_status !== 'completed';
  const summary = {
    runs: runs.length,
    passed: runs.filter((r) => r.result === 'PASS').length,
    lost_jobs: runs.filter(lost).length,
    duplicate_completions: runs.reduce((n, r) => n + (r.duplicate_completions || 0), 0),
    mttr_seconds: stats(runs.map((r) => r.mttr_seconds)),
    completion_seconds: stats(runs.map((r) => r.completion_seconds)),
    git_shas: [...new Set(runs.map((r) => r.env && r.env.git_sha).filter(Boolean))],
  };
  return { runs, summary, dir };
}

// GET /ops/chaos — recorded chaos/bench runs + aggregate summary (read-only)
router.get('/chaos', ...operator, (_req, res) => res.json(loadChaos()));

control(router, operator);

module.exports = router;
module.exports.loadChaos = loadChaos;
