'use strict';

// Reaper: moves jobs whose worker stopped heartbeating from jobs:processing back to
// jobs:pending (or dead-letter after MAX_RETRIES). Heartbeat = test_runs.updated_at.
const producer = require('./redis-producer');
const repo     = require('../db/repositories/test-run-repo');
const logger   = require('../logger');
const metrics  = require('../metrics');

const PENDING    = process.env.JOBS_PENDING_QUEUE    || 'jobs:pending';
const PROCESSING = process.env.JOBS_PROCESSING_QUEUE || 'jobs:processing';
const DEAD       = process.env.JOBS_DL_QUEUE         || 'jobs:dead-letter';
const STALE_MS    = parseInt(process.env.REAPER_STALE_MS    || '20000', 10); // 4x heartbeat interval
const INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '5000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES        || '3', 10);
const TERMINAL = ['completed', 'failed', 'cancelled'];

// Atomic move: only the caller whose LREM succeeds pushes, so concurrent reapers can't duplicate.
// Empty ARGV[2] = just drop the entry. ARGV[3] = cancel tombstone key: if the run is being cancelled, drop instead of push.
const MOVE = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  if ARGV[2] ~= '' and (ARGV[3] == '' or redis.call('EXISTS', ARGV[3]) == 0) then redis.call('LPUSH', KEYS[2], ARGV[2]) end
  return 1
end
return 0`;

// Ownership protocol (epoch = fencing token stored in test_runs.epoch):
//   A worker that popped payload `attempt = a` runs as epoch a+1 and sends it on every write/heartbeat.
//   1. claim  : DB UPDATE (running + silent, or pending + stranded in processing; epoch < a+2) -> status 'pending', epoch a+2. The old owner (a+1) is
//               now fenced out and a worker that finished first makes the claim fail, so nothing gets queued.
//   2. move   : Lua LREM + LPUSH of the retry payload (attempt a+1, whose owner will run as a+2) or DLQ.
// A reaper crash between 1 and 2 leaves the old payload in jobs:processing with row.epoch >= a+2: that is
// recognisable as "already claimed" and the next pass completes the move without a second claim. (Retries
// exhausted: the claim marks the run 'failed', so that state is a failed row whose payload is still in processing.)
// raw payload -> first time this reaper saw it in jobs:processing. Used only for rows still 'pending': a worker that
// popped a job and died before PATCHing 'running' leaves no DB heartbeat, so the time in processing is the signal.
const firstSeen = new Map();

async function reapOnce({ redis = producer.getClient(), runs = repo, now = Date.now(), seen = firstSeen } = {}) {
  const raws = await redis.lrange(PROCESSING, 0, -1);
  for (const r of seen.keys()) if (!raws.includes(r)) seen.delete(r);
  for (const r of raws) if (!seen.has(r)) seen.set(r, now);
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

    const prev       = Number.isInteger(job.attempt) ? job.attempt : 0;
    const fenceEpoch = prev + 2;
    const attempt    = prev + 1;
    const dead       = attempt >= MAX_RETRIES;
    const silentMs   = now - new Date(row.updated_at).getTime();
    const alreadyClaimed = (row.epoch || 0) >= fenceEpoch; // an earlier claim whose Redis move never happened

    // 'failed' + retries exhausted + payload still in processing = the dead-letter copy was never written: a worker
    // died between recording 'failed' and its atomic move, or a reaper claim died before its move. Finish it.
    const needsDlq = row.status === 'failed' && dead;

    // Other terminal rows (finished before ack, or cancelled): drop the entry, never re-queue it.
    if (TERMINAL.includes(row.status) && !needsDlq) {
      await redis.eval(MOVE, 2, PROCESSING, PENDING, raw, '', '');
      continue;
    }

    if (!alreadyClaimed && !needsDlq) {
      // 'running': judged by the heartbeat. 'pending': a just-popped job has an old updated_at (its queue time) until
      // the worker PATCHes running, so judge it by how long it has sat in processing instead.
      const stale = row.status === 'running' ? silentMs >= STALE_MS
                  : row.status === 'pending' && now - seen.get(raw) >= STALE_MS;
      if (!stale) continue;
      const claimed = await runs.claimStale(job.id, {
        newEpoch: fenceEpoch,
        cutoff: new Date(now - STALE_MS).toISOString(),
        errorMessage: 'worker lost (no heartbeat)',
        dead,
        completedAt: new Date(now).toISOString(),
      });
      if (!claimed) continue; // finished, cancelled or heartbeated since we read it: the worker still owns it
    }

    const reason  = needsDlq ? (row.error_message || 'max retries exceeded') : 'worker lost (no heartbeat)';
    const retry   = { ...job, attempt, lastError: reason };
    if (dead) Object.assign(retry, { deadLetterReason: retry.lastError, deadLetteredAt: new Date(now).toISOString() });

    const moved = await redis.eval(MOVE, 2, PROCESSING, dead ? DEAD : PENDING, raw, JSON.stringify(retry), `${producer.CANCELLED_PREFIX}${job.id}`);
    if (moved !== 1) continue; // another reaper got it first

    metrics.inc('reaped_total');
    logger.warn('job_reaped', { jobId: job.id, attempt, silentMs, deadLettered: dead, resumedClaim: alreadyClaimed });
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

module.exports = { reapOnce, startReaper, MOVE };
