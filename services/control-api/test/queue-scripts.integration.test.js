'use strict';

// Real-Redis check of the reaper's atomic move (mocks can't prove atomicity or the cancel tombstone). Skipped without
// TEST_REDIS_URL:  TEST_REDIS_URL=redis://localhost:6379 npx jest test/queue-scripts
const URL = process.env.TEST_REDIS_URL;
const d = URL ? describe : describe.skip;

jest.mock('../src/db/repositories/test-run-repo');

d('reaper MOVE script (redis)', () => {
  const Redis = require('ioredis');
  const { MOVE } = require('../src/queue/reaper');
  const p = `t${process.pid}:`;
  const [FROM, TO, TOMB] = [`${p}processing`, `${p}pending`, `${p}cancelled:a`];
  let r;
  beforeAll(() => { r = new Redis(URL); });
  afterAll(async () => { await r.del(FROM, TO, TOMB); await r.quit(); });
  beforeEach(() => r.del(FROM, TO, TOMB));

  it('moves the entry and pushes the replacement', async () => {
    await r.lpush(FROM, 'old');
    expect(await r.eval(MOVE, 2, FROM, TO, 'old', 'new', TOMB)).toBe(1);
    expect(await r.lrange(FROM, 0, -1)).toEqual([]);
    expect(await r.lrange(TO, 0, -1)).toEqual(['new']);
  });

  it('removes the entry but pushes nothing once a cancel tombstone exists', async () => {
    await r.lpush(FROM, 'old'); await r.set(TOMB, '1');
    expect(await r.eval(MOVE, 2, FROM, TO, 'old', 'new', TOMB)).toBe(1);
    expect(await r.lrange(FROM, 0, -1)).toEqual([]);
    expect(await r.lrange(TO, 0, -1)).toEqual([]);
  });

  it('pushes nothing if another caller already took the entry (no duplicate)', async () => {
    expect(await r.eval(MOVE, 2, FROM, TO, 'old', 'new', TOMB)).toBe(0);
    expect(await r.lrange(TO, 0, -1)).toEqual([]);
  });

  it('empty payload just drops the entry', async () => {
    await r.lpush(FROM, 'old');
    expect(await r.eval(MOVE, 2, FROM, TO, 'old', '', '')).toBe(1);
    expect(await r.lrange(TO, 0, -1)).toEqual([]);
  });
});
