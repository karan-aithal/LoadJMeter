'use strict';

const { createControl } = require('../src/control/control');
const state = require('../src/control/state');

const logger = { warn: jest.fn(), info: jest.fn() };
function make(extra = {}) {
	const redis = { set: jest.fn().mockResolvedValue('OK'), zadd: jest.fn().mockResolvedValue(1), hgetall: jest.fn().mockResolvedValue({ maxRetries: '7' }), del: jest.fn(), zrem: jest.fn() };
	const c = createControl({ redis, sub: { on: jest.fn(), subscribe: jest.fn(), disconnect: jest.fn() }, workerId: 'w1', logger, drain: jest.fn(), exit: jest.fn(), ...extra });
	return { c, redis };
}
const cmd = (c, target, name, args) => c.handle(JSON.stringify({ target, cmd: name, args }));
beforeEach(() => { state.settings = {}; state.partitionedUntil = 0; });

test('tick publishes presence with state and loads settings', async () => {
	const { c, redis } = make();
	c.setJob('run-1');
	await c.tick();
	expect(JSON.parse(redis.set.mock.calls[0][1])).toMatchObject({ workerId: 'w1', state: 'busy', runId: 'run-1' });
	expect(c.int('maxRetries', 3)).toBe(7);
	expect(c.int('heartbeatIntervalMs', 5000)).toBe(5000);
});

test('pause and resume toggle intake; commands for other workers are ignored', () => {
	const { c } = make();
	cmd(c, 'w2', 'pause'); expect(c.isPaused()).toBe(false);
	cmd(c, 'w1', 'pause'); expect(c.isPaused()).toBe(true);
	cmd(c, '*', 'resume'); expect(c.isPaused()).toBe(false);
});

test('drain stops intake via the shutdown hook; crash exits 137', () => {
	const drain = jest.fn(); const exit = jest.fn();
	const { c } = make({ drain, exit });
	cmd(c, 'w1', 'drain'); expect(drain).toHaveBeenCalled();
	cmd(c, 'w1', 'crash'); expect(exit).toHaveBeenCalledWith(137);
});

test('partition blocks until its deadline, then clears', () => {
	let t = 1000;
	const { c } = make({ now: () => t });
	cmd(c, 'w1', 'partition', { seconds: 10 });
	expect(state.partitionedUntil).toBe(11000);
	t = 12000; expect(state.partitionedUntil > t).toBe(false);
});

test('malformed messages are ignored', () => {
	const { c } = make();
	expect(() => c.handle('not json')).not.toThrow();
});
