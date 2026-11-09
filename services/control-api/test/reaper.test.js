'use strict';

jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer', () => ({ getClient: jest.fn() }));

const { reapOnce } = require('../src/queue/reaper');

const NOW = Date.parse('2026-01-01T00:01:00Z');
const row = (id, status, ageMs) => ({ id, status, updated_at: new Date(NOW - ageMs).toISOString() });

function setup(job, dbRow) {
  const raw = JSON.stringify(job);
  const redis = { lrange: jest.fn().mockResolvedValue([raw]), eval: jest.fn().mockResolvedValue(1) };
  const runs = { findByIds: jest.fn().mockResolvedValue([dbRow]), updateStatus: jest.fn() };
  return { raw, redis, runs };
}

describe('reapOnce', () => {
  it('requeues stale running job with attempt+1', async () => {
    const { raw, redis, runs } = setup({ id: 'a' }, row('a', 'running', 60000));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(1);
    const [, , from, to, oldRaw, newRaw] = redis.eval.mock.calls[0];
    expect([from, to, oldRaw]).toEqual(['jobs:processing', 'jobs:pending', raw]);
    expect(JSON.parse(newRaw).attempt).toBe(1);
    expect(runs.updateStatus).toHaveBeenCalledWith('a', expect.objectContaining({ status: 'pending' }));
  });

  it('leaves job with fresh heartbeat alone', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'running', 5000));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(0);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('leaves just-popped (pending row) job alone', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'pending', 600000));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(0);
  });

  it('dead-letters when attempts exhausted', async () => {
    const { redis, runs } = setup({ id: 'a', attempt: 2 }, row('a', 'running', 60000));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][3]).toBe('jobs:dead-letter');
    expect(runs.updateStatus).toHaveBeenCalledWith('a', expect.objectContaining({ status: 'failed' }));
  });

  it('drops entry whose run already finished', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'completed', 60000));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][5]).toBe('');
    expect(runs.updateStatus).not.toHaveBeenCalled();
  });
});
