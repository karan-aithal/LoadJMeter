'use strict';

const axios = require('axios');
const logger = require('./logger');
const { runK6 } = require('./runner/k6-runner');
const { parseK6Result } = require('./runner/result-parser');
const { pushDeadLetter } = require('./queue/dead-letter');
const { popJob, ackJob, requeueJob, quit } = require('./queue/redis-consumer');
const { startHeartbeat } = require('./heartbeat/heartbeat');
const {
	installSignalHandlers,
	isShuttingDown,
	setRunCanceller,
} = require('./lifecycle/graceful-shutdown');

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://control-api:4000';
const WORKER_API_KEY = process.env.WORKER_API_KEY || process.env.API_KEY;
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

async function updateRunStatus(jobId, payload) {
	try {
		await axios.patch(`${CONTROL_API_URL}/tests/${jobId}/status`, payload, {
			timeout: 8000,
			headers: { 'x-api-key': WORKER_API_KEY },
		});
	} catch (err) {
		logger.warn('status update failed', { jobId, error: err.message });
	}
}

function getNextAttempt(job) {
	const current = Number.isInteger(job.attempt) ? job.attempt : 0;
	return current + 1;
}

async function executeJob(job) {
	const attempt = getNextAttempt(job);

	await updateRunStatus(job.id, {
		status: 'running',
		workerId: WORKER_ID,
		startedAt: new Date().toISOString(),
		errorMessage: null,
	});

	const stopHeartbeat = startHeartbeat(job.id, WORKER_ID);
	const run = runK6(job.config || {});
	setRunCanceller(run.cancel);

	const result = await run.done;
	stopHeartbeat();
	setRunCanceller(null);

	const parsed = parseK6Result(result);
	if (parsed.status === 'completed') {
		await updateRunStatus(job.id, {
			status: 'completed',
			verdict: parsed.verdict,
			completedAt: new Date().toISOString(),
			errorMessage: null,
		});
		await ackJob(job);
		logger.info('job completed', { jobId: job.id, attempt });
		return;
	}

	if (attempt >= MAX_RETRIES) {
		await pushDeadLetter({ ...job, attempt }, parsed.errorMessage || 'max retries exceeded');
		await updateRunStatus(job.id, {
			status: 'failed',
			verdict: parsed.verdict || 'FAIL',
			completedAt: new Date().toISOString(),
			errorMessage: parsed.errorMessage || 'max retries exceeded',
		});
		await ackJob(job);
		logger.warn('job moved to dead-letter', { jobId: job.id, attempt });
		return;
	}

	const retryJob = {
		...job,
		attempt,
		lastError: parsed.errorMessage || `failed with exit code ${result.code}`,
	};
	await requeueJob(job, retryJob);
	await updateRunStatus(job.id, {
		status: 'pending',
		verdict: null,
		errorMessage: retryJob.lastError,
	});
	logger.warn('job requeued for retry', { jobId: job.id, attempt, maxRetries: MAX_RETRIES });
}

async function runLoop() {
	installSignalHandlers();
	logger.info('worker started', { workerId: WORKER_ID, maxRetries: MAX_RETRIES });

	while (!isShuttingDown()) {
		try {
			const job = await popJob({ timeoutSeconds: 2 });
			if (!job) continue;

			logger.info('job picked', {
				jobId: job.id,
				attempt: Number.isInteger(job.attempt) ? job.attempt : 0,
			});
			await executeJob(job);
		} catch (err) {
			logger.error('worker loop error', { error: err.message });
		}
	}

	await quit();
	logger.info('worker stopped');
	process.exit(0);
}

runLoop().catch((err) => {
	logger.error('fatal worker error', { error: err.message });
	process.exit(1);
});
