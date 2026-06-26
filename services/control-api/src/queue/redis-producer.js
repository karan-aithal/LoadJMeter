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

async function disconnect() {
  if (client) { await client.quit(); client = null; }
}

module.exports = { enqueue, disconnect, getClient };
