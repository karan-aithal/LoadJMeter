'use strict';

const Redis = require('ioredis');
const logger = require('../logger');

const PENDING_QUEUE = process.env.JOBS_PENDING_QUEUE || 'jobs:pending';
const PROCESSING_QUEUE = process.env.JOBS_PROCESSING_QUEUE || 'jobs:processing';
const DEAD_LETTER_QUEUE = process.env.JOBS_DL_QUEUE || 'jobs:dead-letter';
const CANCELLED_PREFIX = 'jobs:cancelled:';

let client;

function getClient() {
	if (!client) {
		client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
			maxRetriesPerRequest: 3,
			enableReadyCheck: true,
			lazyConnect: true,
		});
		client.on('error', (err) => {
			logger.error('redis client error', { error: err.message });
		});
	}
	return client;
}

async function popJob({ timeoutSeconds = 2 } = {}) {
	const redis = getClient();
	const payload = await redis.brpoplpush(PENDING_QUEUE, PROCESSING_QUEUE, timeoutSeconds);
	if (!payload) return null;

	try {
		return JSON.parse(payload);
	} catch (err) {
		logger.error('invalid job payload JSON, dropping from processing queue', { error: err.message });
		await redis.lrem(PROCESSING_QUEUE, 1, payload);
		return null;
	}
}

async function ackJob(job) {
	const redis = getClient();
	await redis.lrem(PROCESSING_QUEUE, 1, JSON.stringify(job));
}

// Re-queue only if we still hold the entry. If the reaper already moved it (we were fenced out), LREM is 0
// and nothing is pushed, so a stale worker can't create a second copy. ARGV[3] = cancel tombstone: a run being
// cancelled is dropped, not re-queued. Returns true only if the retry was queued.
const REQUEUE = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  if redis.call('EXISTS', ARGV[3]) == 0 then redis.call('LPUSH', KEYS[2], ARGV[2]) return 1 end
  return 2
end
return 0`;

async function requeueJob(originalJob, retryJob) {
	const redis = getClient();
	const r = await redis.eval(REQUEUE, 2, PROCESSING_QUEUE, PENDING_QUEUE, JSON.stringify(originalJob),
		JSON.stringify(retryJob), `${CANCELLED_PREFIX}${originalJob.id}`);
	return r === 1;
}

// Dead-letter = ack + DLQ push as ONE atomic step. If they were separate, a crash between them either lost the DLQ
// copy or left a duplicate; now either both happen or neither (and the reaper finishes a missing one).
const DEAD_LETTER = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  redis.call('LPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0`;

async function moveToDeadLetter(originalJob, deadJob) {
	const redis = getClient();
	return (await redis.eval(DEAD_LETTER, 2, PROCESSING_QUEUE, DEAD_LETTER_QUEUE,
		JSON.stringify(originalJob), JSON.stringify(deadJob))) === 1;
}

async function quit() {
	if (client) {
		await client.quit();
		client = null;
	}
}

module.exports = {
	getClient,
	popJob,
	ackJob,
	requeueJob,
	moveToDeadLetter,
	quit,
	PENDING_QUEUE,
	PROCESSING_QUEUE,
};
