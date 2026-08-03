'use strict';

const os = require("node:os");
const axios = require('axios');
const logger = require('./logger');
const { runK6 } = require('./runner/k6-runner');
const { parseK6Result } = require('./runner/result-parser');
const { pushDeadLetter } = require('./queue/dead-letter');
const { popJob, ackJob, requeueJob, quit } = require('./queue/redis-consumer');
const { startHeartbeat } = require('./heartbeat/heartbeat');
const { startMetricsServer } = require('./metrics/prometheus-exporter');
const {
	installSignalHandlers,
	isShuttingDown,
	setRunCanceller,
} = require('./lifecycle/graceful-shutdown');

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://control-api:4000';
const WORKER_API_KEY = process.env.WORKER_API_KEY || process.env.API_KEY;
//const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const WORKER_ID =
  process.env.WORKER_ID ||
  process.env.HOSTNAME ||
  os.hostname();

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const metrics = startMetricsServer();

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
	const startedAtMs = Date.now();
	const attempt = getNextAttempt(job);
	metrics.setCurrentJob(true);

	await updateRunStatus(job.id, {
		status: 'running',
		workerId: WORKER_ID,
		startedAt: new Date().toISOString(),
		errorMessage: null,
	});

	const stopHeartbeat = startHeartbeat(job.id, WORKER_ID, {
		onFailure: () => metrics.recordHeartbeatFailure(),
	});
	const run = runK6(job.config || {});
	setRunCanceller(run.cancel);

	const result = await run.done;
	stopHeartbeat();
	setRunCanceller(null);

	const parsed = parseK6Result(result, {
		fleetSaturated: metrics.wasSaturatedSince(startedAtMs),
	});
	if (parsed.status === 'completed') {
		await updateRunStatus(job.id, {
			status: 'completed',
			verdict: parsed.verdict,
			completedAt: new Date().toISOString(),
			errorMessage: parsed.errorMessage,
		});
		await ackJob(job);
		metrics.recordOutcome(parsed.verdict.toLowerCase());
		metrics.setCurrentJob(false);
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
		metrics.recordOutcome('failed');
		metrics.setCurrentJob(false);
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
	metrics.recordOutcome('retry');
	metrics.setCurrentJob(false);
	logger.warn('job requeued for retry', { jobId: job.id, attempt, maxRetries: MAX_RETRIES });
}

async function runLoop() {
	installSignalHandlers();
	logger.info('worker started', { workerId: WORKER_ID, maxRetries: MAX_RETRIES });

	while (!isShuttingDown()) {
		try {
			metrics.incQueuePoll();
			const job = await popJob({ timeoutSeconds: 2 });
			if (!job) continue;

			logger.info('job picked', {
				jobId: job.id,
				attempt: Number.isInteger(job.attempt) ? job.attempt : 0,
			});
			await executeJob(job);
		} catch (err) {
			metrics.setCurrentJob(false);
			logger.error('worker loop error', { error: err.message });
		}
	}

	await metrics.close();
	await quit();
	logger.info('worker stopped');
	process.exit(0);
}

runLoop().catch((err) => {
	logger.error('fatal worker error', { error: err.message });
	process.exit(1);
});
