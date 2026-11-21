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
} = require('./lifecycle/graceful-shutdown');

const WORKER_ID =
  process.env.WORKER_ID ||
  process.env.HOSTNAME ||
  os.hostname();

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const metrics = startMetricsServer();

const executeJob = createExecutor({
	workerId: WORKER_ID,
	maxRetries: MAX_RETRIES,
	metrics,
	logger,
	updateRunStatus,
	runK6,
	startHeartbeat,
	parseK6Result,
	setRunCanceller,
	queue: { ackJob, requeueJob, deadLetterJob },
});

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
