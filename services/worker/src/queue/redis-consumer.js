'use strict';

const Redis = require('ioredis');
const logger = require('../logger');

const PENDING_QUEUE = process.env.JOBS_PENDING_QUEUE || 'jobs:pending';
const PROCESSING_QUEUE = process.env.JOBS_PROCESSING_QUEUE || 'jobs:processing';

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

async function requeueJob(originalJob, retryJob) {
	const redis = getClient();
	await redis.lrem(PROCESSING_QUEUE, 1, JSON.stringify(originalJob));
	await redis.lpush(PENDING_QUEUE, JSON.stringify(retryJob));
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
	quit,
	PENDING_QUEUE,
	PROCESSING_QUEUE,
};
