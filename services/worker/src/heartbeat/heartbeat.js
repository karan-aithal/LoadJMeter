'use strict';

const axios = require('axios');
const logger = require('../logger');

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://control-api:4000';
const WORKER_API_KEY = process.env.WORKER_API_KEY || process.env.API_KEY;

async function postHeartbeat(jobId, workerId) {
	try {
		await axios.post(
			`${CONTROL_API_URL}/tests/${jobId}/heartbeat`,
			{ workerId },
			{
				timeout: 5000,
				headers: {
					'x-api-key': WORKER_API_KEY,
				},
			}
		);
	} catch (err) {
		logger.warn('heartbeat failed', { jobId, error: err.message });
	}
}

function startHeartbeat(jobId, workerId, { onFailure } = {}) {
	const intervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '5000', 10);
	const timer = setInterval(() => {
		postHeartbeat(jobId, workerId).catch(() => {
			if (typeof onFailure === 'function') onFailure();
		});
	}, intervalMs);

	return () => clearInterval(timer);
}

module.exports = { startHeartbeat, postHeartbeat };
