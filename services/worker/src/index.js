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
const STATUS_TRIES = 3;
const STATUS_RETRY_MS = 1000;
const metrics = startMetricsServer();

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

function getNextAttempt(job) {
	const current = Number.isInteger(job.attempt) ? job.attempt : 0;
	return current + 1;
}

// Ownership: this execution's epoch is its attempt number. Every write/heartbeat carries it; the control-api
// rejects it (409) once the reaper or a newer attempt has taken the job, and we then walk away without touching
// the DB or Redis again. We only ack/re-queue in Redis after the DB accepted our final write.
async function executeJob(job) {
	const startedAtMs = Date.now();
	const attempt = getNextAttempt(job);
	const epoch = attempt;
	metrics.setCurrentJob(true);
	// first attempt only: retries/reaped jobs keep the original createdAt, so their "wait" would include earlier runs
	if (attempt === 1) metrics.observeQueueWait((startedAtMs - Date.parse(job.createdAt)) / 1000);

	const claim = await updateRunStatus(job.id, {
		status: 'running',
		workerId: WORKER_ID,
		startedAt: new Date().toISOString(),
		errorMessage: null,
		epoch,
	});
	if (claim === 'fenced') { // cancelled/finished/re-owned while queued: don't run it
		metrics.setCurrentJob(false);
		logger.warn('job skipped: not owner at start', { jobId: job.id, attempt });
		return;
	}

	let lostOwnership = false;
	const run = runK6(job.config || {});
	setRunCanceller(run.cancel);
	const stopHeartbeat = startHeartbeat(job.id, WORKER_ID, epoch, {
		onFailure: () => metrics.recordHeartbeatFailure(),
		onFenced: () => { lostOwnership = true; run.cancel(); },
	});

	const result = await run.done;
	stopHeartbeat();
	setRunCanceller(null);

	if (lostOwnership) {
		metrics.setCurrentJob(false);
		logger.warn('ownership lost, result discarded', { jobId: job.id, attempt });
		return;
	}

	const parsed = parseK6Result(result, {
		fleetSaturated: metrics.wasSaturatedSince(startedAtMs),
	});
	const done = (outcome) => {
		metrics.recordOutcome(outcome);
		metrics.observeJob({ outcome, durationSec: (Date.now() - startedAtMs) / 1000 });
		metrics.setCurrentJob(false);
	};
	// Not 'ok' = leave the entry in jobs:processing: the reaper requeues it if we are really gone, and a
	// fenced worker's copy was already moved. Acking here would lose the job.
	const abandon = (why, r) => {
		metrics.setCurrentJob(false);
		logger.warn(why, { jobId: job.id, attempt, writeResult: r });
	};

	if (parsed.status === 'completed') {
		const r = await updateRunStatus(job.id, {
			status: 'completed',
			verdict: parsed.verdict,
			completedAt: new Date().toISOString(),
			errorMessage: parsed.errorMessage,
			epoch,
		});
		if (r !== 'ok') return abandon('completion not recorded, job left in processing', r);
		await ackJob(job);
		done(parsed.verdict.toLowerCase());
		logger.info('job completed', { jobId: job.id, attempt });
		return;
	}

	if (attempt >= MAX_RETRIES) {
		const r = await updateRunStatus(job.id, {
			status: 'failed',
			verdict: parsed.verdict || 'FAIL',
			completedAt: new Date().toISOString(),
			errorMessage: parsed.errorMessage || 'max retries exceeded',
			epoch,
		});
		if (r !== 'ok') return abandon('failure not recorded, job left in processing', r);
		await pushDeadLetter({ ...job, attempt }, parsed.errorMessage || 'max retries exceeded');
		await ackJob(job);
		done('failed');
		logger.warn('job moved to dead-letter', { jobId: job.id, attempt });
		return;
	}

	const retryJob = {
		...job,
		attempt,
		lastError: parsed.errorMessage || `failed with exit code ${result.code}`,
	};
	// DB first: it refuses if the run was cancelled/finished/re-owned, so no retry is queued behind a terminal
	// state. epoch+1 fences this execution out; if we die before the Redis step the reaper sees row.epoch >=
	// payload.attempt+2 and finishes the move.
	const r = await updateRunStatus(job.id, {
		status: 'pending',
		verdict: null,
		errorMessage: retryJob.lastError,
		epoch,
		nextEpoch: epoch + 1,
	});
	if (r !== 'ok') return abandon('retry not recorded, job left in processing', r);
	const queued = await requeueJob(job, retryJob);
	done('retry');
	logger.warn(queued ? 'job requeued for retry' : 'retry already moved by reaper', { jobId: job.id, attempt, maxRetries: MAX_RETRIES });
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
