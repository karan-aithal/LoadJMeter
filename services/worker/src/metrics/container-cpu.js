'use strict';

// Container-level CPU accounting from cgroups. process.cpuUsage() sees only the
// Node process, not the k6 child that does the real work, and os.cpus() reports
// host cores, not the container limit. cgroup counters cover every process in
// the container and include CFS throttling.
const fs = require('fs');
const os = require('os');

const V2 = { stat: '/sys/fs/cgroup/cpu.stat', max: '/sys/fs/cgroup/cpu.max' };
const V1 = {
	usage: '/sys/fs/cgroup/cpuacct/cpuacct.usage',
	stat: '/sys/fs/cgroup/cpu/cpu.stat',
	quota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
	period: '/sys/fs/cgroup/cpu/cpu.cfs_period_us',
};

const read = (p) => fs.readFileSync(p, 'utf8');

function parseKv(text) {
	const out = {};
	for (const line of text.split('\n')) {
		const [k, v] = line.trim().split(/\s+/);
		if (k) out[k] = Number(v);
	}
	return out;
}

// Returns { usageUs, throttledUs, limitCores } or null if no cgroup is readable.
// readFile is injectable for tests.
function readCgroup(readFile = read, hostCores = os.cpus().length) {
	try {
		const s = parseKv(readFile(V2.stat));
		const [quota, period] = readFile(V2.max).trim().split(/\s+/);
		return {
			source: 'cgroup-v2',
			usageUs: s.usage_usec,
			throttledUs: s.throttled_usec || 0,
			limitCores: quota === 'max' ? hostCores : Number(quota) / Number(period),
		};
	} catch (_e) { /* not v2 */ }
	try {
		const quota = Number(readFile(V1.quota));
		const period = Number(readFile(V1.period));
		let throttledUs = 0;
		try { throttledUs = (parseKv(readFile(V1.stat)).throttled_time || 0) / 1000; } catch (_e) { /* optional */ }
		return {
			source: 'cgroup-v1',
			usageUs: Number(readFile(V1.usage)) / 1000,
			throttledUs,
			limitCores: quota < 0 ? hostCores : quota / period,
		};
	} catch (_e) { return null; }
}

// Delta sampler. sample() returns { usedCores, ratio, throttledDeltaUs, limitCores, source }.
// ratio = cores used / cores allowed (limit), clamped to 0..1.
// Fallback (no cgroup) is Node-process-only and is labelled source:'process' so it is never mistaken for container CPU.
function createCpuSampler({ readFile = read, now = Date.now, hostCores = os.cpus().length } = {}) {
	const snap = () => readCgroup(readFile, hostCores);
	let prev = snap();
	let prevProc = process.cpuUsage();
	let prevTs = now();

	return function sample() {
		const ts = now();
		const wallUs = Math.max(1, (ts - prevTs) * 1000);
		const cur = snap();
		let res;
		if (cur && prev) {
			const usedCores = Math.max(0, cur.usageUs - prev.usageUs) / wallUs;
			res = {
				source: cur.source,
				usedCores,
				limitCores: cur.limitCores,
				throttledDeltaUs: Math.max(0, cur.throttledUs - prev.throttledUs),
			};
		} else {
			const d = process.cpuUsage(prevProc);
			res = { source: 'process', usedCores: (d.user + d.system) / wallUs, limitCores: hostCores, throttledDeltaUs: 0 };
		}
		res.ratio = Math.max(0, Math.min(1, res.usedCores / res.limitCores));
		prev = cur;
		prevProc = process.cpuUsage();
		prevTs = ts;
		return res;
	};
}

module.exports = { createCpuSampler, readCgroup };
