'use strict';

// Operator control of this worker: publishes presence for the dashboard and obeys commands from control-api.
//   pause/resume : stop/start popping new jobs (a running job continues)
//   drain        : finish the current job, then exit
//   crash        : exit now, no cleanup (what a SIGKILL looks like to the rest of the system)
//   partition    : for N seconds heartbeats and status writes fail as if control-api were unreachable
const state = require('./state');

const CHANNEL = 'ops:worker:cmd';
const PREFIX = 'ops:worker:';
const INDEX = 'ops:workers';
const SETTINGS_KEY = 'ops:settings';
const TICK_MS = 2000;
const TTL_S = 15;

function createControl({ redis, sub, workerId, logger, drain, exit = (c) => process.exit(c), now = Date.now }) {
	let paused = false;
	let draining = false;
	let runId = null;
	let timer = null;

	const label = () => {
		if (state.partitionedUntil > now()) return 'partitioned';
		if (draining) return 'draining';
		if (paused) return 'paused';
		return runId ? 'busy' : 'idle';
	};

	async function tick() {
		const t = now();
		const presence = { workerId, state: label(), runId, paused, draining, pid: process.pid, lastSeen: t,
			partitionedUntil: state.partitionedUntil > t ? state.partitionedUntil : null };
		try {
			await redis.set(PREFIX + workerId, JSON.stringify(presence), 'EX', TTL_S);
			await redis.zadd(INDEX, t, workerId);
			state.settings = (await redis.hgetall(SETTINGS_KEY)) || {};
		} catch (err) {
			logger.warn('control tick failed', { error: err.message });
		}
	}

	function handle(raw) {
		let m; try { m = JSON.parse(raw); } catch { return; }
		if (!m || (m.target !== '*' && m.target !== workerId)) return;
		logger.warn('operator command', { cmd: m.cmd, args: m.args });
		switch (m.cmd) {
			case 'pause': paused = true; break;
			case 'resume': paused = false; break;
			case 'drain': draining = true; drain(); break;
			case 'crash': exit(137); break;
			case 'partition': state.partitionedUntil = now() + (m.args && m.args.seconds ? m.args.seconds * 1000 : 30000); break;
			default: return;
		}
		tick();
	}

	async function start() {
		sub.on('message', (_ch, raw) => handle(raw));
		await sub.subscribe(CHANNEL);
		await tick();
		timer = setInterval(tick, TICK_MS);
		timer.unref();
	}

	async function stop() {
		clearInterval(timer);
		try { await redis.del(PREFIX + workerId); await redis.zrem(INDEX, workerId); } catch { /* best effort: TTL cleans up */ }
		try { sub.disconnect(); } catch { /* already closed */ }
	}

	return {
		start, stop, tick, handle,
		isPaused: () => paused && !draining,
		setJob: (id) => { runId = id; },
		// a runtime setting from Redis, else the env-derived default
		int: (name, fallback) => { const n = parseInt(state.settings[name], 10); return Number.isInteger(n) ? n : fallback; },
	};
}

module.exports = { createControl };
