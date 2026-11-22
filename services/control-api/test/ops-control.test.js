'use strict';

jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer');
jest.mock('../src/runs', () => ({ launch: jest.fn() }));
jest.mock('../src/db/migrate', () => ({ runMigrations: jest.fn().mockResolvedValue() }));
jest.mock('../src/db/client',  () => ({ query: jest.fn(), connect: jest.fn() }));

process.env.JWT_SECRET = 'test-secret-minimum-32-chars-long!!';
process.env.API_KEY    = 'test-api-key';

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { app }  = require('../src/index');
const repo     = require('../src/db/repositories/test-run-repo');
const producer = require('../src/queue/redis-producer');
const settings = require('../src/ops/settings');

const AUTH = `Bearer ${jwt.sign({ sub: 'op', role: 'operator' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const post = (path, body) => request(app).post(path).set('Authorization', AUTH).send(body || {});

let redis;
const enableChaos = async () => { redis.hgetall.mockResolvedValue({ chaosEnabled: 'true' }); await settings.load(redis); };
beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.CHAOS_ENABLED;
  delete process.env.CHAOS_DRIVER;
  redis = {
    hgetall: jest.fn().mockResolvedValue({}), hset: jest.fn().mockResolvedValue(1),
    lpush: jest.fn().mockResolvedValue(1), ltrim: jest.fn().mockResolvedValue('OK'), lrange: jest.fn().mockResolvedValue([]),
    lrem: jest.fn().mockResolvedValue(1), publish: jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(0), zrange: jest.fn().mockResolvedValue(['w1']),
    mget: jest.fn().mockResolvedValue([JSON.stringify({ workerId: 'w1', state: 'idle', lastSeen: Date.now() })]),
  };
  producer.getClient.mockReturnValue(redis);
  await settings.load(redis);
  producer.markCancelled.mockResolvedValue();
  repo.cancel.mockResolvedValue({});
});

describe('PUT /ops/settings', () => {
  it('stores a valid change and audits it', async () => {
    const r = await request(app).put('/ops/settings').set('Authorization', AUTH).send({ maxRetries: 5 });
    expect(r.status).toBe(200);
    expect(r.body.values.maxRetries).toBe(5);
    expect(redis.hset).toHaveBeenCalledWith('ops:settings', { maxRetries: '5' });
    expect(JSON.parse(redis.lpush.mock.calls[0][1])).toMatchObject({ action: 'settings.update', actor: 'op', result: 'ok' });
  });
  it.each([[{ maxRetries: 99 }], [{ nope: 1 }], [{ intakePaused: 'yes' }], [{ reaperStaleMs: 5000, heartbeatIntervalMs: 4000 }]])('400 for %j', async (body) => {
    const r = await request(app).put('/ops/settings').set('Authorization', AUTH).send(body);
    expect(r.status).toBe(400);
    expect(redis.hset).not.toHaveBeenCalled();
  });
});

describe('chaos toggle', () => {
  it('env sets the default and PUT /ops/settings flips it at runtime', async () => {
    expect((await post('/ops/workers/w1/crash')).status).toBe(403);
    expect((await request(app).put('/ops/settings').set('Authorization', AUTH).send({ chaosEnabled: true })).status).toBe(200);
    expect((await post('/ops/workers/w1/crash')).status).toBe(200);
    expect((await request(app).put('/ops/settings').set('Authorization', AUTH).send({ chaosEnabled: false })).status).toBe(200);
    expect((await post('/ops/workers/w1/crash')).status).toBe(403);
  });
  it('CHAOS_ENABLED=true is the default when nothing is stored', async () => {
    process.env.CHAOS_ENABLED = 'true';
    await settings.load(redis);
    expect((await post('/ops/workers/w1/crash')).status).toBe(200);
  });
});

describe('intake pause', () => {
  it('POST /tests answers 503 while paused', async () => {
    await settings.set({ intakePaused: true }, redis);
    redis.hgetall.mockResolvedValue({ intakePaused: 'true' });
    await settings.load(redis);
    const r = await request(app).post('/tests').set('Authorization', AUTH).set('Idempotency-Key', 'k1')
      .send({ scenario: 'fast', vus: 1, duration: '10s' });
    expect(r.status).toBe(503);
    await settings.set({ intakePaused: false }, redis);
  });
});

describe('worker commands', () => {
  it('pause is allowed without the chaos flag and is published + audited', async () => {
    const r = await post('/ops/workers/w1/pause');
    expect(r.status).toBe(200);
    expect(JSON.parse(redis.publish.mock.calls[0][1])).toMatchObject({ target: 'w1', cmd: 'pause' });
    expect(redis.lpush).toHaveBeenCalled();
  });
  it('crash / drain / partition are 403 until CHAOS_ENABLED', async () => {
    for (const c of ['crash', 'drain', 'partition']) expect((await post(`/ops/workers/w1/${c}`)).status).toBe(403);
    expect(redis.publish).not.toHaveBeenCalled();
    await enableChaos();
    expect((await post('/ops/workers/w1/crash')).status).toBe(200);
  });
  it('rejects unknown workers, unknown commands and bad partition seconds', async () => {
    await enableChaos();
    expect((await post('/ops/workers/ghost/pause')).status).toBe(404);
    expect((await post('/ops/workers/w1/explode')).status).toBe(400);
    expect((await post('/ops/workers/w1/partition', { seconds: 1 })).status).toBe(400);
    expect((await post('/ops/workers/*/partition', { seconds: 30 })).status).toBe(200);
  });
});

describe('infra chaos', () => {
  it('is 403 unless CHAOS_ENABLED, 501 with no driver', async () => {
    expect((await post('/ops/infra/kill', { target: 'x' })).status).toBe(403);
    await enableChaos();
    delete process.env.CHAOS_DRIVER;
    expect((await post('/ops/infra/kill', { target: 'x' })).status).toBe(501);
  });
});

describe('bulk queue actions', () => {
  it('purging pending cancels each run through the tombstone path', async () => {
    redis.lrange.mockResolvedValueOnce([JSON.stringify({ id: 'a' }), 'garbage']);
    const r = await post('/ops/queues/pending/purge');
    expect(r.body).toEqual({ purged: 2 });
    expect(producer.markCancelled).toHaveBeenCalledWith('a');
    expect(repo.cancel).toHaveBeenCalledWith('a');
  });
  it('requeue-all relaunches every entry and puts a failed one back', async () => {
    const { launch } = require('../src/runs');
    redis.rpush = jest.fn();
    redis.lrange.mockResolvedValueOnce([JSON.stringify({ id: 'a', config: {} }), JSON.stringify({ id: 'b', config: {} })]);
    launch.mockResolvedValueOnce({ id: 'n1' }).mockRejectedValueOnce(new Error('db'));
    const r = await post('/ops/queues/dlq/requeue');
    expect(r.body).toEqual({ requeued: 1, runs: ['n1'] });
    expect(redis.rpush).toHaveBeenCalledTimes(1);
  });
});
