'use strict';

jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer', () => ({ getClient: jest.fn() }));

const { reapOnce } = require('../src/queue/reaper');

const NOW = Date.parse('2026-01-01T00:01:00Z');
const row = (id, status, ageMs, epoch = 1) => ({ id, status, epoch, updated_at: new Date(NOW - ageMs).toISOString() });

function setup(job, dbRow, { claimed = true } = {}) {
  const raw = JSON.stringify(job);
  const redis = { lrange: jest.fn().mockResolvedValue([raw]), eval: jest.fn().mockResolvedValue(1) };
  const runs = { findByIds: jest.fn().mockResolvedValue([dbRow]), claimStale: jest.fn().mockResolvedValue(claimed ? dbRow : null) };
  return { raw, redis, runs };
}

describe('reapOnce', () => {
  it('claims in the DB first, then requeues with attempt+1', async () => {
    const { raw, redis, runs } = setup({ id: 'a' }, row('a', 'running', 60000));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(1);
    // fencing epoch for the next owner = attempt(0) + 2
    expect(runs.claimStale).toHaveBeenCalledWith('a', expect.objectContaining({ newEpoch: 2, dead: false }));
    const [, , from, to, oldRaw, newRaw] = redis.eval.mock.calls[0];
    expect([from, to, oldRaw]).toEqual(['jobs:processing', 'jobs:pending', raw]);
    expect(JSON.parse(newRaw).attempt).toBe(1);
    expect(runs.claimStale.mock.invocationCallOrder[0]).toBeLessThan(redis.eval.mock.invocationCallOrder[0]);
  });

  // Regression: worker finishes / heartbeats between the reaper's read and its write. Before the fix the reaper had
  // already pushed the retry into jobs:pending by then, so a finished job ran a second time.
  it('queues nothing when the claim loses the race to the worker', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'running', 60000), { claimed: false });
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(0);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('claim only matches a row silent since the stale cutoff', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'running', 60000));
    await reapOnce({ redis, runs, now: NOW });
    expect(Date.parse(runs.claimStale.mock.calls[0][1].cutoff)).toBe(NOW - 20000);
  });

  it('leaves job with fresh heartbeat alone', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'running', 5000));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(0);
    expect(runs.claimStale).not.toHaveBeenCalled();
  });

  it('leaves just-popped (pending row) job alone', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'pending', 600000));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(0);
    expect(runs.claimStale).not.toHaveBeenCalled();
  });

  it('dead-letters when attempts exhausted, claiming the run as failed', async () => {
    const { redis, runs } = setup({ id: 'a', attempt: 2 }, row('a', 'running', 60000, 3));
    await reapOnce({ redis, runs, now: NOW });
    expect(runs.claimStale).toHaveBeenCalledWith('a', expect.objectContaining({ newEpoch: 4, dead: true }));
    expect(redis.eval.mock.calls[0][3]).toBe('jobs:dead-letter');
  });

  it('drops entry whose run already finished', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'completed', 60000));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][5]).toBe('');
    expect(runs.claimStale).not.toHaveBeenCalled();
  });

  it('never re-queues a cancelled run, even one claimed earlier', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'cancelled', 60000, 2));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][3]).toBe('jobs:pending');
    expect(redis.eval.mock.calls[0][5]).toBe(''); // dropped, nothing pushed
  });

  it('finishes a move whose claim succeeded but the reaper died before the Redis step', async () => {
    // claim set epoch = attempt(0)+2 and status pending; old payload is still in processing
    const { redis, runs } = setup({ id: 'a' }, row('a', 'pending', 60000, 2));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(1);
    expect(runs.claimStale).not.toHaveBeenCalled();
    expect(redis.eval.mock.calls[0][3]).toBe('jobs:pending');
  });

  it('finishes a dead-letter move after a claim marked the run failed', async () => {
    const { redis, runs } = setup({ id: 'a', attempt: 2 }, row('a', 'failed', 60000, 4));
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(1);
    expect(redis.eval.mock.calls[0][3]).toBe('jobs:dead-letter');
  });

  it("does not mistake a worker's own dead-letter (epoch = attempt+1) for a reaper claim", async () => {
    const { redis, runs } = setup({ id: 'a', attempt: 2 }, row('a', 'failed', 60000, 3));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][5]).toBe(''); // plain drop
  });
});
