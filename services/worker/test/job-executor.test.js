'use strict';

const { createExecutor } = require('../src/job-executor');

// Fakes for every dependency; each test scripts the control-api answers and the k6 outcome.
function setup({ writes = [], parsed = { status: 'completed', verdict: 'PASS', errorMessage: null }, heartbeat } = {}) {
	const log = [];
	const writeQueue = [...writes];
	const updateRunStatus = jest.fn(async (id, payload) => { log.push(['db', payload.status, payload]); return writeQueue.length ? writeQueue.shift() : 'ok'; });
	const queue = {
		ackJob: jest.fn(async () => log.push(['redis', 'ack'])),
		requeueJob: jest.fn(async () => { log.push(['redis', 'requeue']); return true; }),
		deadLetterJob: jest.fn(async () => log.push(['redis', 'dead-letter'])),
	};
	let hb = {};
	let resolveRun;
	const run = { cancel: jest.fn(() => resolveRun({ code: 1, signal: 'SIGTERM', stdout: '', stderr: '' })), done: new Promise((r) => { resolveRun = r; }) };
	const startHeartbeat = jest.fn((id, w, epoch, cbs) => { hb = { epoch, ...cbs }; heartbeat?.(hb, run, resolveRun); return jest.fn(); });
	const runK6 = jest.fn(() => { if (!heartbeat) setImmediate(() => resolveRun({ code: 0, signal: null, stdout: '', stderr: '' })); return run; });
	const metrics = { setCurrentJob: jest.fn(), observeQueueWait: jest.fn(), observeJob: jest.fn(), recordOutcome: jest.fn(),
		recordHeartbeatFailure: jest.fn(), wasSaturatedSince: jest.fn(() => false) };
	const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
	const executeJob = createExecutor({ workerId: 'w1', maxRetries: 3, metrics, logger, updateRunStatus, runK6, startHeartbeat,
		parseK6Result: () => parsed, setRunCanceller: jest.fn(), queue });
	return { executeJob, updateRunStatus, queue, runK6, startHeartbeat, metrics, log, run, getHb: () => hb };
}
const JOB = (attempt) => ({ id: 'j', config: { scenario: 'fast' }, createdAt: '2026-01-01T00:00:00Z', ...(attempt === undefined ? {} : { attempt }) });

describe('executeJob: ownership', () => {
	it('sends epoch = attempt on every write and on heartbeats', async () => {
		const t = setup();
		await t.executeJob(JOB(1)); // popped payload attempt 1 -> this run is attempt/epoch 2
		expect(t.updateRunStatus.mock.calls.map((c) => c[1].epoch)).toEqual([2, 2]);
		expect(t.getHb().epoch).toBe(2);
	});

	it('does not run k6 when the start write is fenced (cancelled / re-owned while queued)', async () => {
		const t = setup({ writes: ['fenced'] });
		await t.executeJob(JOB());
		expect(t.runK6).not.toHaveBeenCalled();
		expect(t.queue.ackJob).not.toHaveBeenCalled();
		expect(t.metrics.setCurrentJob).toHaveBeenLastCalledWith(false);
	});

	it('stale worker: heartbeat 409 cancels k6 and nothing else is written or touched in Redis', async () => {
		const t = setup({ heartbeat: (hb) => setImmediate(() => hb.onFenced()) });
		await t.executeJob(JOB());
		expect(t.run.cancel).toHaveBeenCalled();
		expect(t.updateRunStatus).toHaveBeenCalledTimes(1); // only the initial 'running' claim
		expect(t.queue.ackJob).not.toHaveBeenCalled();
		expect(t.queue.requeueJob).not.toHaveBeenCalled();
		expect(t.queue.deadLetterJob).not.toHaveBeenCalled();
	});

	it('heartbeat failures (partition) are counted but do not stop the job', async () => {
		const t = setup({ heartbeat: (hb, run, resolve) => setImmediate(() => { hb.onFailure(); resolve({ code: 0, signal: null, stdout: '', stderr: '' }); }) });
		await t.executeJob(JOB());
		expect(t.metrics.recordHeartbeatFailure).toHaveBeenCalled();
		expect(t.queue.ackJob).toHaveBeenCalled();
	});
});

describe('executeJob: completion', () => {
	it('acks only after the DB accepted the completion', async () => {
		const t = setup();
		await t.executeJob(JOB());
		expect(t.log.map((l) => l.slice(0, 2).join(':'))).toEqual(['db:running', 'db:completed', 'redis:ack']);
	});

	it.each(['fenced', 'error'])("never acks when the completion write is '%s' (stale worker / partition)", async (res) => {
		const t = setup({ writes: ['ok', res] });
		await t.executeJob(JOB());
		expect(t.queue.ackJob).not.toHaveBeenCalled();
		expect(t.metrics.recordOutcome).not.toHaveBeenCalled();
	});
});

describe('executeJob: retries and dead-letter', () => {
	const failed = { status: 'failed', verdict: 'FAIL', errorMessage: 'boom' };

	it('retry: DB write (epoch+1) happens BEFORE the Redis re-queue', async () => {
		const t = setup({ parsed: failed });
		await t.executeJob(JOB()); // attempt 1 of 3
		expect(t.log.map((l) => l.slice(0, 2).join(':'))).toEqual(['db:running', 'db:pending', 'redis:requeue']);
		const pending = t.updateRunStatus.mock.calls[1][1];
		expect(pending).toMatchObject({ status: 'pending', epoch: 1, nextEpoch: 2 });
		expect(t.queue.requeueJob.mock.calls[0][1]).toMatchObject({ attempt: 1, lastError: 'boom' });
	});

	it.each(['fenced', 'error'])("retry: no Redis re-queue when the DB write is '%s' (cancelled run, re-owned job)", async (res) => {
		const t = setup({ parsed: failed, writes: ['ok', res] });
		await t.executeJob(JOB());
		expect(t.queue.requeueJob).not.toHaveBeenCalled();
	});

	it('dead-letter: DB failed first, then one atomic dead-letter move (no separate ack)', async () => {
		const t = setup({ parsed: failed });
		await t.executeJob(JOB(2)); // attempt 3 = maxRetries
		expect(t.log.map((l) => l.slice(0, 2).join(':'))).toEqual(['db:running', 'db:failed', 'redis:dead-letter']);
		expect(t.queue.deadLetterJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'j' }), 3, 'boom');
		expect(t.queue.ackJob).not.toHaveBeenCalled();
	});

	it.each(['fenced', 'error'])("dead-letter: nothing is moved when the failed write is '%s'", async (res) => {
		const t = setup({ parsed: failed, writes: ['ok', res] });
		await t.executeJob(JOB(2));
		expect(t.queue.deadLetterJob).not.toHaveBeenCalled();
	});
});
