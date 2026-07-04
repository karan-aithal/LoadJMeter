'use strict';

const { spawn } = require('child_process');

const SCENARIO_TO_SCRIPT = {
	base: '/app/scripts/k6/base-scenario.js',
	fast: '/app/scripts/k6/fast-endpoint.js',
	slow: '/app/scripts/k6/slow-endpoint.js',
	'cpu-heavy': '/app/scripts/k6/cpu-heavy.js',
};

function buildEnv(config) {
	return {
		...process.env,
		SUT_URL: config.sutUrl || process.env.SUT_URL || 'http://sut:3000',
		VUS: String(config.vus),
		DURATION: config.duration,
		RAMP_UP: config.rampUp || process.env.RAMP_UP || '10s',
		RAMP_DOWN: config.rampDown || process.env.RAMP_DOWN || '10s',
	};
}

function resolveScript(scenario) {
	return SCENARIO_TO_SCRIPT[scenario] || SCENARIO_TO_SCRIPT.base;
}

function runK6(config) {
	const scriptPath = resolveScript(config.scenario);
	const args = ['run'];

	// Push k6 runtime metrics to Prometheus if remote-write URL is configured.
	if (process.env.K6_PROMETHEUS_RW_SERVER_URL) {
		args.push('--out', 'experimental-prometheus-rw');
	}

	args.push(scriptPath);

	const child = spawn('k6', args, {
		env: buildEnv(config),
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';

	child.stdout.on('data', (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});

	return {
		cancel: () => {
			try { child.kill('SIGTERM'); } catch (_) {}
		},
		done: new Promise((doneResolve) => {
			child.on('close', (code, signal) => {
				doneResolve({ code: code === null ? 1 : code, signal, stdout, stderr });
			});
		}),
	};
}

module.exports = { runK6 };
