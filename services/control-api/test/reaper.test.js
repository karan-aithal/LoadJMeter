'use strict';

jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer', () => ({ getClient: jest.fn(), CANCELLED_PREFIX: 'jobs:cancelled:' }));

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

  it('leaves just-popped (pending row) job alone, however old its queue time', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'pending', 600000));
    expect(await reapOnce({ redis, runs, now: NOW, seen: new Map() })).toBe(0);
    expect(runs.claimStale).not.toHaveBeenCalled();
  });

  // Regression: worker popped the job, then died before PATCHing 'running'. The row stays 'pending' with its old
  // queue-time updated_at, so the heartbeat can't tell; the job sat in jobs:processing forever.
  it('recovers a job stranded in processing with a pending row after the stale window', async () => {
    const { raw, redis, runs } = setup({ id: 'a' }, row('a', 'pending', 600000));
    const seen = new Map([[raw, NOW - 21000]]);
    expect(await reapOnce({ redis, runs, now: NOW, seen })).toBe(1);
    expect(runs.claimStale).toHaveBeenCalledWith('a', expect.objectContaining({ newEpoch: 2, dead: false }));
    expect(redis.eval.mock.calls[0][3]).toBe('jobs:pending');
  });

  it('does not recover a pending row that was popped less than the stale window ago', async () => {
    const { raw, redis, runs } = setup({ id: 'a' }, row('a', 'pending', 600000));
    const seen = new Map([[raw, NOW - 5000]]);
    expect(await reapOnce({ redis, runs, now: NOW, seen })).toBe(0);
  });

  it('forgets payloads that left processing', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'running', 5000));
    const seen = new Map([['gone', NOW - 99999]]);
    await reapOnce({ redis, runs, now: NOW, seen });
    expect(seen.has('gone')).toBe(false);
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

  // Regression: the worker recorded 'failed' (DB) but crashed before its atomic processing->DLQ move, so the
  // dead-letter copy was never written and the reaper used to drop the entry.
  it("writes the missing dead-letter copy for a worker's own 'failed' run", async () => {
    const dbRow = { ...row('a', 'failed', 60000, 3), error_message: 'k6 exited 99' };
    const { redis, runs } = setup({ id: 'a', attempt: 2 }, dbRow);
    expect(await reapOnce({ redis, runs, now: NOW })).toBe(1);
    expect(runs.claimStale).not.toHaveBeenCalled();
    const [, , , to, , payload] = redis.eval.mock.calls[0];
    expect(to).toBe('jobs:dead-letter');
    expect(JSON.parse(payload)).toMatchObject({ attempt: 3, deadLetterReason: 'k6 exited 99' });
  });

  it("does not dead-letter a 'failed' run that still has retries left", async () => {
    const { redis, runs } = setup({ id: 'a', attempt: 0 }, row('a', 'failed', 60000, 1));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][5]).toBe(''); // plain drop
  });

  // Regression: a cancel started after the reaper's DB claim. The Lua move must see the tombstone atomically.
  it('passes the cancel tombstone key so the move cannot queue behind a cancel', async () => {
    const { redis, runs } = setup({ id: 'a' }, row('a', 'running', 60000));
    await reapOnce({ redis, runs, now: NOW });
    expect(redis.eval.mock.calls[0][6]).toBe('jobs:cancelled:a');
  });
});
