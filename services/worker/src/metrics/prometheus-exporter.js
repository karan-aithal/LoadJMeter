'use strict';

const http = require('http');
const os = require('os');
const client = require('prom-client');
const logger = require('../logger');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'worker_process_' });

const workerJobsTotal = new client.Counter({
	name: 'worker_jobs_total',
	help: 'Total worker jobs by outcome',
	labelNames: ['outcome'],
	registers: [register],
});

const workerCurrentJob = new client.Gauge({
	name: 'worker_current_job',
	help: 'Whether worker currently has an active job (1/0)',
	registers: [register],
});

const workerQueuePollTotal = new client.Counter({
	name: 'worker_queue_poll_total',
	help: 'Total queue poll attempts',
	registers: [register],
});

const workerHeartbeatFailuresTotal = new client.Counter({
	name: 'worker_heartbeat_failures_total',
	help: 'Total heartbeat failures',
	registers: [register],
});

const workerCpuSaturationRatio = new client.Gauge({
	name: 'worker_cpu_saturation_ratio',
	help: 'Estimated worker CPU saturation ratio (0..1)',
	registers: [register],
});

const workerSaturationBreachesTotal = new client.Counter({
	name: 'worker_saturation_breaches_total',
	help: 'Total times CPU saturation crossed threshold',
	registers: [register],
});

let lastBreachedAtMs = 0;

function startCpuSampler() {
	const threshold = Number(process.env.FLEET_CPU_SAT_THRESHOLD || '0.8');
	const intervalMs = parseInt(process.env.CPU_SAMPLE_INTERVAL_MS || '2000', 10);
	const coreCount = Math.max(1, (os.cpus() || []).length);
	let lastUsage = process.cpuUsage();
	let lastTs = Date.now();

	setInterval(() => {
		const now = Date.now();
		const deltaUsage = process.cpuUsage(lastUsage);
		const deltaWallUs = Math.max(1, (now - lastTs) * 1000);
		const cpuUsedUs = deltaUsage.user + deltaUsage.system;
		const ratio = Math.max(0, Math.min(1, cpuUsedUs / (deltaWallUs * coreCount)));

		workerCpuSaturationRatio.set(ratio);
		if (ratio > threshold) {
			lastBreachedAtMs = now;
			workerSaturationBreachesTotal.inc();
		}

		lastUsage = process.cpuUsage();
		lastTs = now;
	}, intervalMs).unref();
}

function startMetricsServer() {
	const port = parseInt(process.env.WORKER_METRICS_PORT || '9464', 10);
	const server = http.createServer(async (req, res) => {
		if (req.url === '/metrics') {
			res.writeHead(200, { 'Content-Type': register.contentType });
			res.end(await register.metrics());
			return;
		}
		if (req.url === '/healthz' || req.url === '/readyz') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ status: 'ok' }));
			return;
		}
		res.writeHead(404);
		res.end('not found');
	});

	server.listen(port, () => {
		logger.info('worker metrics server started', { port });
	});

	startCpuSampler();

	return {
		incQueuePoll: () => workerQueuePollTotal.inc(),
		setCurrentJob: (active) => workerCurrentJob.set(active ? 1 : 0),
		recordHeartbeatFailure: () => workerHeartbeatFailuresTotal.inc(),
		recordOutcome: (outcome) => workerJobsTotal.inc({ outcome }),
		wasSaturatedSince: (startMs) => lastBreachedAtMs >= startMs,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

module.exports = { startMetricsServer };
