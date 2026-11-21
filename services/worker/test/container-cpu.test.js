'use strict';

const { createCpuSampler, readCgroup } = require('../src/metrics/container-cpu');

function fakeFs(files) {
	return (p) => {
		if (!(p in files)) throw new Error('ENOENT');
		return typeof files[p] === 'function' ? files[p]() : files[p];
	};
}

describe('container cpu sampler', () => {
	it('v2: counts cgroup usage (k6 child included) against cpu.max limit', () => {
		let usage = 0;
		let t = 0;
		const readFile = fakeFs({
			'/sys/fs/cgroup/cpu.stat': () => `usage_usec ${usage}\nthrottled_usec 0\n`,
			'/sys/fs/cgroup/cpu.max': '100000 100000', // 1 core
		});
		const sample = createCpuSampler({ readFile, now: () => t, hostCores: 4 });
		usage = 500000; t = 2000; // 0.5 CPU-s in 2 s wall = 0.25 cores
		const s = sample();
		expect(s.source).toBe('cgroup-v2');
		expect(s.usedCores).toBeCloseTo(0.25);
		expect(s.limitCores).toBe(1);
		expect(s.ratio).toBeCloseTo(0.25);
	});

	it('v2: unlimited uses host cores; throttling is a delta', () => {
		let throttled = 0;
		const readFile = fakeFs({
			'/sys/fs/cgroup/cpu.stat': () => `usage_usec 0\nthrottled_usec ${throttled}\n`,
			'/sys/fs/cgroup/cpu.max': 'max 100000',
		});
		expect(readCgroup(readFile, 4).limitCores).toBe(4);
		let t = 0;
		const sample = createCpuSampler({ readFile, now: () => t, hostCores: 4 });
		throttled = 300000; t = 1000;
		expect(sample().throttledDeltaUs).toBe(300000);
	});

	it('v1: ns usage converted, quota/period limit', () => {
		let ns = 0, t = 0;
		const readFile = fakeFs({
			'/sys/fs/cgroup/cpuacct/cpuacct.usage': () => String(ns),
			'/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000',
			'/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
		});
		const sample = createCpuSampler({ readFile, now: () => t, hostCores: 8 });
		ns = 1e9; t = 1000; // 1 core-s / 1 s = 1 core of 2
		const s = sample();
		expect(s.source).toBe('cgroup-v1');
		expect(s.ratio).toBeCloseTo(0.5);
	});

	it('no cgroup: falls back, labelled source=process', () => {
		const sample = createCpuSampler({ readFile: fakeFs({}), now: (() => { let n = 0; return () => (n += 1000); })(), hostCores: 2 });
		expect(sample().source).toBe('process');
	});
});
