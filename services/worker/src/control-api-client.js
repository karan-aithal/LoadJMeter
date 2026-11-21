'use strict';

const axios = require('axios');
const logger = require('./logger');

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://control-api:4000';
const WORKER_API_KEY = process.env.WORKER_API_KEY || process.env.API_KEY;
const STATUS_TRIES = 3;
const STATUS_RETRY_MS = parseInt(process.env.STATUS_RETRY_MS || '1000', 10);

// 'ok'     : control-api applied the write.
// 'fenced' : 409, we no longer own this job (reaped and re-owned, finished elsewhere, or cancelled). Stop touching it.
// 'error'  : control-api unreachable after retries (e.g. network partition). Ownership unknown: never ack on this.
async function updateRunStatus(jobId, payload) {
	let lastErr;
	for (let i = 1; i <= STATUS_TRIES; i++) {
		try {
			await axios.patch(`${CONTROL_API_URL}/tests/${jobId}/status`, payload, {
				timeout: 8000,
				headers: { 'x-api-key': WORKER_API_KEY },
			});
			return 'ok';
		} catch (err) {
			if (err.response?.status === 409) {
				logger.warn('status update fenced', { jobId, status: payload.status, epoch: payload.epoch });
				return 'fenced';
			}
			lastErr = err;
			logger.warn('status update failed', { jobId, try: i, error: err.message });
			if (i < STATUS_TRIES) await new Promise((r) => setTimeout(r, STATUS_RETRY_MS));
		}
	}
	logger.error('status update gave up', { jobId, status: payload.status, error: lastErr.message });
	return 'error';
}

module.exports = { updateRunStatus, STATUS_TRIES };
