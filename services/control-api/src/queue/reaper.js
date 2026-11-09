'use strict';

// Reaper: moves jobs whose worker stopped heartbeating from jobs:processing back to
// jobs:pending (or dead-letter after MAX_RETRIES). Heartbeat = test_runs.updated_at.
const producer = require('./redis-producer');
const repo     = require('../db/repositories/test-run-repo');
const logger   = require('../logger');

const PENDING    = process.env.JOBS_PENDING_QUEUE    || 'jobs:pending';
const PROCESSING = process.env.JOBS_PROCESSING_QUEUE || 'jobs:processing';
const DEAD       = process.env.JOBS_DL_QUEUE         || 'jobs:dead-letter';
const STALE_MS    = parseInt(process.env.REAPER_STALE_MS    || '20000', 10); // 4x heartbeat interval
const INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '5000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES        || '3', 10);
const TERMINAL = ['completed', 'failed', 'cancelled'];

// Atomic move: only the caller whose LREM succeeds pushes, so concurrent reapers can't duplicate.
// Empty ARGV[2] = just drop the entry.
const MOVE = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  if ARGV[2] ~= '' then redis.call('LPUSH', KEYS[2], ARGV[2]) end
  return 1
end
return 0`;

async function reapOnce({ redis = producer.getClient(), runs = repo, now = Date.now() } = {}) {
  const raws = await redis.lrange(PROCESSING, 0, -1);
  const jobs = [];
  for (const raw of raws) {
    try { jobs.push({ raw, job: JSON.parse(raw) }); } catch { /* worker drops bad JSON itself */ }
  }
  if (!jobs.length) return 0;

  const rows = await runs.findByIds(jobs.map((j) => j.job.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let reaped = 0;

  for (const { raw, job } of jobs) {
    const row = byId.get(job.id);
    if (!row) continue;

    if (TERMINAL.includes(row.status)) { // worker died before ack, or run cancelled
      await redis.eval(MOVE, 2, PROCESSING, PENDING, raw, '');
      continue;
    }
    // Only 'running': a just-popped job has old updated_at until the worker PATCHes running.
    const silentMs = now - new Date(row.updated_at).getTime();
    if (row.status !== 'running' || silentMs < STALE_MS) continue;

    const attempt = (Number.isInteger(job.attempt) ? job.attempt : 0) + 1;
    const dead    = attempt >= MAX_RETRIES;
    const retry   = { ...job, attempt, lastError: 'worker lost (no heartbeat)' };
    if (dead) Object.assign(retry, { deadLetterReason: retry.lastError, deadLetteredAt: new Date(now).toISOString() });

    const moved = await redis.eval(MOVE, 2, PROCESSING, dead ? DEAD : PENDING, raw, JSON.stringify(retry));
    if (moved !== 1) continue; // another reaper or the worker got it first

    await runs.updateStatus(job.id, {
      status: dead ? 'failed' : 'pending',
      errorMessage: retry.lastError,
      ...(dead && { verdict: 'FAIL', completedAt: new Date(now).toISOString() }),
    });
    logger.warn('job_reaped', { jobId: job.id, attempt, silentMs, deadLettered: dead });
    reaped++;
  }
  return reaped;
}

function startReaper() {
  const timer = setInterval(() => {
    reapOnce().catch((err) => logger.error('reaper error', { error: err.message }));
  }, INTERVAL_MS);
  timer.unref();
  logger.info('Reaper started', { staleMs: STALE_MS, intervalMs: INTERVAL_MS });
  return () => clearInterval(timer);
}

module.exports = { reapOnce, startReaper };
