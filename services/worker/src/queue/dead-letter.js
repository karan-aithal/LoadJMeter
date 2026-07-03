'use strict';

const { getClient } = require('./redis-consumer');

const DLQ = process.env.JOBS_DL_QUEUE || 'jobs:dead-letter';

async function pushDeadLetter(job, reason) {
	const redis = getClient();
	const payload = {
		...job,
		deadLetterReason: reason,
		deadLetteredAt: new Date().toISOString(),
	};
	await redis.lpush(DLQ, JSON.stringify(payload));
}

module.exports = { pushDeadLetter, DLQ };
