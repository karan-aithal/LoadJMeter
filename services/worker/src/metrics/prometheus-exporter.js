'use strict';

const http = require('http');
const client = require('prom-client');
const logger = require('../logger');
const { createCpuSampler } = require('./container-cpu');

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
	help: 'Container CPU used / container CPU limit (0..1), cgroup-based, includes k6 child',
	registers: [register],
});

const workerCpuCoresUsed = new client.Gauge({
	name: 'worker_container_cpu_cores_used',
	help: 'Container CPU cores consumed (all processes incl. k6), cgroup delta over the sample interval',
	registers: [register],
});

const workerCpuLimitCores = new client.Gauge({
	name: 'worker_container_cpu_limit_cores',
	help: 'Container CPU limit in cores (cgroup cpu.max; host cores if unlimited)',
	registers: [register],
});

const workerCpuThrottledSeconds = new client.Counter({
	name: 'worker_container_cpu_throttled_seconds_total',
	help: 'Seconds the container was CFS-throttled at its CPU limit',
	registers: [register],
});

const workerCpuSource = new client.Gauge({
	name: 'worker_cpu_source',
	help: 'CPU accounting source in use (1 for the active label); source=process means NO cgroup, k6 not counted',
	labelNames: ['source'],
	registers: [register],
});

const workerJobDuration = new client.Histogram({
	name: 'worker_job_duration_seconds',
	help: 'Wall time from job pick to outcome (includes k6 run)',
	labelNames: ['outcome'],
	buckets: [5, 15, 30, 45, 60, 90, 120, 300],
	registers: [register],
});

const workerQueueWait = new client.Histogram({
	name: 'worker_job_queue_wait_seconds',
	help: 'Time from job creation (control-api) to worker pick; pod-to-pod clock skew applies',
	buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
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
	const sample = createCpuSampler();

	setInterval(() => {
		const s = sample();
		workerCpuSaturationRatio.set(s.ratio);
		workerCpuCoresUsed.set(s.usedCores);
		workerCpuLimitCores.set(s.limitCores);
		workerCpuThrottledSeconds.inc(s.throttledDeltaUs / 1e6);
		workerCpuSource.reset();
		workerCpuSource.set({ source: s.source }, 1);
		if (s.ratio > threshold) {
			lastBreachedAtMs = Date.now();
			workerSaturationBreachesTotal.inc();
		}
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
		observeJob: ({ outcome, durationSec }) => workerJobDuration.observe({ outcome }, durationSec),
		observeQueueWait: (sec) => { if (Number.isFinite(sec) && sec >= 0) workerQueueWait.observe(sec); },
		wasSaturatedSince: (startMs) => lastBreachedAtMs >= startMs,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

module.exports = { startMetricsServer };
