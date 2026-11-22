'use strict';

const os = require("node:os");
const logger = require('./logger');
const { runK6 } = require('./runner/k6-runner');
const { parseK6Result } = require('./runner/result-parser');
const { deadLetterJob } = require('./queue/dead-letter');
const { updateRunStatus } = require('./control-api-client');
const { createExecutor } = require('./job-executor');
const { popJob, ackJob, requeueJob, quit } = require('./queue/redis-consumer');
const { startHeartbeat } = require('./heartbeat/heartbeat');
const { startMetricsServer } = require('./metrics/prometheus-exporter');
const {
	installSignalHandlers,
	isShuttingDown,
	setRunCanceller,
	drain,
} = require('./lifecycle/graceful-shutdown');
const { createControl } = require('./control/control');
const { getClient } = require('./queue/redis-consumer');

const WORKER_ID =
  process.env.WORKER_ID ||
  process.env.HOSTNAME ||
  os.hostname();

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const metrics = startMetricsServer();

const control = createControl({ redis: getClient(), sub: getClient().duplicate(), workerId: WORKER_ID, logger, drain });

const runJob = createExecutor({
	workerId: WORKER_ID,
	maxRetries: () => control.int('maxRetries', MAX_RETRIES),
	metrics,
	logger,
	updateRunStatus,
	runK6,
	startHeartbeat,
	parseK6Result,
	setRunCanceller,
	queue: { ackJob, requeueJob, deadLetterJob },
});

async function executeJob(job) {
	control.setJob(job.id);
	try { await runJob(job); } finally { control.setJob(null); }
}

async function runLoop() {
	installSignalHandlers();
	await control.start();
	logger.info('worker started', { workerId: WORKER_ID, maxRetries: MAX_RETRIES });

	while (!isShuttingDown()) {
		try {
			if (control.isPaused()) { await new Promise((r) => setTimeout(r, 1000)); continue; }
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

	await control.stop();
	await metrics.close();
	await quit();
	logger.info('worker stopped');
	process.exit(0);
}

runLoop().catch((err) => {
	logger.error('fatal worker error', { error: err.message });
	process.exit(1);
});
