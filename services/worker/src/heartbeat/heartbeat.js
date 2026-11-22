'use strict';

const axios = require('axios');
const logger = require('../logger');
const state = require('../control/state');

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://control-api:4000';
const WORKER_API_KEY = process.env.WORKER_API_KEY || process.env.API_KEY;

async function postHeartbeat(jobId, workerId, epoch) {
	try {
		if (state.partitionedUntil > Date.now()) throw new Error('simulated partition');
		await axios.post(
			`${CONTROL_API_URL}/tests/${jobId}/heartbeat`,
			{ workerId, epoch },
			{
				timeout: 5000,
				headers: {
					'x-api-key': WORKER_API_KEY,
				},
			}
		);
	} catch (err) {
		// 409 = control-api fenced us out (job reaped/re-owned, finished or cancelled): not a transient failure
		err.fenced = err.response?.status === 409;
		logger.warn(err.fenced ? 'heartbeat fenced' : 'heartbeat failed', { jobId, error: err.message });
		throw err; // let startHeartbeat's callbacks fire
	}
}

function startHeartbeat(jobId, workerId, epoch, { onFailure, onFenced } = {}) {
	const intervalMs = parseInt(state.settings.heartbeatIntervalMs || process.env.HEARTBEAT_INTERVAL_MS || '5000', 10);
	const timer = setInterval(() => {
		postHeartbeat(jobId, workerId, epoch).catch((err) => {
			if (err.fenced) {
				clearInterval(timer);
				if (typeof onFenced === 'function') onFenced();
			} else if (typeof onFailure === 'function') onFailure();
		});
	}, intervalMs);

	return () => clearInterval(timer);
}

module.exports = { startHeartbeat, postHeartbeat };
