'use strict';

// Real-Redis check of the worker's re-queue and dead-letter scripts. Skipped without TEST_REDIS_URL:
//   TEST_REDIS_URL=redis://localhost:6379 npx jest test/queue-scripts
const URL = process.env.TEST_REDIS_URL;
const d = URL ? describe : describe.skip;

d('worker queue scripts (redis)', () => {
	const p = `t${process.pid}:`;
	process.env.REDIS_URL = URL;
	process.env.JOBS_PENDING_QUEUE = `${p}pending`;
	process.env.JOBS_PROCESSING_QUEUE = `${p}processing`;
	process.env.JOBS_DL_QUEUE = `${p}dlq`;
	const consumer = require('../src/queue/redis-consumer');
	const { deadLetterJob } = require('../src/queue/dead-letter');
	const job = { id: `x${process.pid}`, config: { scenario: 'fast' } };
	const tomb = `jobs:cancelled:${job.id}`;
	let r;
	beforeAll(() => { r = consumer.getClient(); });
	afterAll(async () => { await r.del(`${p}pending`, `${p}processing`, `${p}dlq`, tomb); await consumer.quit(); });
	beforeEach(() => r.del(`${p}pending`, `${p}processing`, `${p}dlq`, tomb));

	it('requeueJob moves the entry and queues the retry', async () => {
		await r.lpush(`${p}processing`, JSON.stringify(job));
		expect(await consumer.requeueJob(job, { ...job, attempt: 1 })).toBe(true);
		expect(await r.llen(`${p}processing`)).toBe(0);
		expect(JSON.parse(await r.lindex(`${p}pending`, 0)).attempt).toBe(1);
	});

	it('requeueJob queues nothing if the reaper already moved the entry (stale worker)', async () => {
		expect(await consumer.requeueJob(job, { ...job, attempt: 1 })).toBe(false);
		expect(await r.llen(`${p}pending`)).toBe(0);
	});

	it('requeueJob drops instead of queuing once the run is being cancelled', async () => {
		await r.lpush(`${p}processing`, JSON.stringify(job)); await r.set(tomb, '1');
		expect(await consumer.requeueJob(job, { ...job, attempt: 1 })).toBe(false);
		expect(await r.llen(`${p}processing`)).toBe(0);
		expect(await r.llen(`${p}pending`)).toBe(0);
	});

	it('deadLetterJob acks and dead-letters in one step', async () => {
		await r.lpush(`${p}processing`, JSON.stringify(job));
		expect(await deadLetterJob(job, 3, 'boom')).toBe(true);
		expect(await r.llen(`${p}processing`)).toBe(0);
		expect(JSON.parse(await r.lindex(`${p}dlq`, 0))).toMatchObject({ id: job.id, attempt: 3, deadLetterReason: 'boom' });
	});

	it('deadLetterJob writes no duplicate copy if the entry is already gone', async () => {
		expect(await deadLetterJob(job, 3, 'boom')).toBe(false);
		expect(await r.llen(`${p}dlq`)).toBe(0);
	});
});
