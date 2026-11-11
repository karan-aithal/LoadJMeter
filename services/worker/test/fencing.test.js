'use strict';

jest.mock('axios');
jest.mock('ioredis');
jest.mock('../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const axios = require('axios');
const Redis = require('ioredis');

describe('heartbeat fencing', () => {
	beforeEach(() => { jest.useFakeTimers(); axios.post.mockReset(); });
	afterEach(() => jest.useRealTimers());

	const load = () => require('../src/heartbeat/heartbeat');
	const tick = async () => { jest.advanceTimersByTime(5000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

	it('sends the worker epoch', async () => {
		axios.post.mockResolvedValue({});
		const stop = load().startHeartbeat('j', 'w1', 3, {});
		await tick();
		expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/tests/j/heartbeat'), { workerId: 'w1', epoch: 3 }, expect.any(Object));
		stop();
	});

	it('409 calls onFenced once, stops heartbeating, and is not counted as a heartbeat failure', async () => {
		axios.post.mockRejectedValue(Object.assign(new Error('conflict'), { response: { status: 409 } }));
		const onFenced = jest.fn(); const onFailure = jest.fn();
		load().startHeartbeat('j', 'w1', 1, { onFenced, onFailure });
		await tick(); await tick();
		expect(onFenced).toHaveBeenCalledTimes(1);
		expect(onFailure).not.toHaveBeenCalled();
		expect(axios.post).toHaveBeenCalledTimes(1); // timer cleared
	});

	it('network error (partition) is a failure, not fencing, and keeps heartbeating', async () => {
		axios.post.mockRejectedValue(new Error('ETIMEDOUT'));
		const onFenced = jest.fn(); const onFailure = jest.fn();
		const stop = load().startHeartbeat('j', 'w1', 1, { onFenced, onFailure });
		await tick(); await tick();
		expect(onFailure).toHaveBeenCalledTimes(2);
		expect(onFenced).not.toHaveBeenCalled();
		stop();
	});
});

describe('requeueJob', () => {
	beforeEach(() => Redis.mockReset());

	it('re-queues only while this worker still holds the processing entry', async () => {
		const evalMock = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		Redis.mockImplementation(() => ({ on: jest.fn(), eval: evalMock }));
		const { requeueJob } = require('../src/queue/redis-consumer');
		expect(await requeueJob({ id: 'a' }, { id: 'a', attempt: 1 })).toBe(true);
		// reaper already moved it (we were fenced out): LREM finds nothing, nothing is pushed
		expect(await requeueJob({ id: 'a' }, { id: 'a', attempt: 1 })).toBe(false);
		const [lua, nKeys, from, to, orig, retry] = evalMock.mock.calls[0];
		expect(lua).toMatch(/LREM.*==\s*1[\s\S]*LPUSH/);
		expect([nKeys, from, to, orig, retry]).toEqual([2, 'jobs:processing', 'jobs:pending', '{"id":"a"}', '{"id":"a","attempt":1}']);
	});
});
