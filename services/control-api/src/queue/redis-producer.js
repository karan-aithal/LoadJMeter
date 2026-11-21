'use strict';

const Redis  = require('ioredis');
const logger = require('../logger');

// Queue key — must match shared/constants/queue-keys.js and worker consumer
const JOBS_PENDING = process.env.JOBS_PENDING_QUEUE || 'jobs:pending';

let client = null;

function getClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    client.on('error', (err) => logger.error('Redis error', { error: err.message }));
  }
  return client;
}

/**
 * Enqueue a job. Idempotent via a Redis key-per-job-id (NX SET, 24h TTL).
 * Returns true if enqueued, false if duplicate.
 */
async function enqueue(job) {
  const redis   = getClient();
  const lockKey = `job:enqueued:${job.id}`;

  const set = await redis.set(lockKey, '1', 'EX', 86400, 'NX');
  if (!set) {
    logger.warn('Duplicate enqueue skipped', { jobId: job.id });
    return false;
  }

  await redis.lpush(JOBS_PENDING, JSON.stringify(job));
  logger.info('Job enqueued', { jobId: job.id, queue: JOBS_PENDING });
  return true;
}

// Cancel tombstone: set BEFORE the DB write in DELETE /tests/:id. The reaper's and the worker's Lua re-queue scripts
// check it atomically with their LPUSH, so nothing is queued once a cancel has started. (A cancel that begins after
// a push is the ordinary cancel-of-a-queued-job case: the worker skips it when its 'running' write is refused.)
const CANCELLED_PREFIX = 'jobs:cancelled:';
async function markCancelled(id) {
  await getClient().set(`${CANCELLED_PREFIX}${id}`, '1', 'EX', 86400);
}

async function disconnect() {
  if (client) { await client.quit(); client = null; }
}

module.exports = { enqueue, disconnect, getClient, markCancelled, CANCELLED_PREFIX };
