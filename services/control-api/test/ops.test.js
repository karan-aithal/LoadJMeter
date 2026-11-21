'use strict';

jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer');
jest.mock('../src/runs', () => ({ launch: jest.fn() }));
jest.mock('../src/db/migrate', () => ({ runMigrations: jest.fn().mockResolvedValue() }));
jest.mock('../src/db/client',  () => ({ query: jest.fn(), connect: jest.fn() }));

process.env.JWT_SECRET = 'test-secret-minimum-32-chars-long!!';
process.env.API_KEY    = 'test-api-key';

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../src/index');
const repo     = require('../src/db/repositories/test-run-repo');
const producer = require('../src/queue/redis-producer');
const { launch } = require('../src/runs');
const { loadChaos } = require('../src/routes/ops');

const TOKEN = jwt.sign({ sub: 'api-user', role: 'operator' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const AUTH  = `Bearer ${TOKEN}`;
const dead  = (id) => JSON.stringify({ id, attempt: 3, config: { scenario: 'fast', vus: 1, duration: '10s' }, deadLetterReason: 'boom' });

let redis;
beforeEach(() => {
  jest.clearAllMocks();
  redis = {
    llen: jest.fn().mockResolvedValue(0),
    lrange: jest.fn().mockResolvedValue([]),
    lrem: jest.fn().mockResolvedValue(1),
    rpush: jest.fn().mockResolvedValue(1),
  };
  producer.getClient.mockReturnValue(redis);
  repo.listActive.mockResolvedValue([]);
  repo.list.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
});

describe('role gate', () => {
  it('401 without auth', async () => {
    expect((await request(app).get('/ops/queues')).status).toBe(401);
  });
  it('403 for the worker key on operator routes', async () => {
    expect((await request(app).get('/ops/queues').set('x-api-key', 'test-api-key')).status).toBe(403);
  });
  it('403 for an operator JWT on worker routes (heartbeat, status)', async () => {
    expect((await request(app).post('/tests/u/heartbeat').set('Authorization', AUTH).send({})).status).toBe(403);
    expect((await request(app).patch('/tests/u/status').set('Authorization', AUTH).send({})).status).toBe(403);
  });
});

describe('GET /ops/queues', () => {
  it('returns depths, parsed items and workers from running rows', async () => {
    redis.llen.mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    redis.lrange.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([dead('d1'), 'not-json']);
    repo.listActive.mockResolvedValue([
      { id: 'r1', status: 'running', worker_id: 'w1', epoch: 1, updated_at: '2026-01-01T00:00:00Z' },
      { id: 'r2', status: 'pending', worker_id: null, epoch: 0 },
    ]);
    const res = await request(app).get('/ops/queues').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.queues.pending.length).toBe(2);
    expect(res.body.queues.dlq.items[0]).toMatchObject({ id: 'd1', deadLetterReason: 'boom' });
    expect(res.body.queues.dlq.items[1].raw).toBe('not-json');
    expect(res.body.workers).toEqual([expect.objectContaining({ workerId: 'w1', runId: 'r1' })]);
    expect(res.body.active).toBe(2);
  });
});

describe('GET /ops/stream', () => {
  it('401 with a bad ?token', async () => {
    expect((await request(app).get('/ops/stream?token=nope')).status).toBe(401);
  });
  it('accepts the JWT as ?token and emits a snapshot event', async () => {
    const body = await new Promise((resolve, reject) => {
      request(app).get(`/ops/stream?token=${TOKEN}`)
        .buffer(true)
        .parse((res, cb) => res.once('data', (d) => { cb(null, d.toString()); res.destroy(); }))
        .end((err, res) => (res ? resolve(res.body) : reject(err)));
    });
    expect(body).toMatch(/^data: \{.*"queues"/);
  });
});

describe('DLQ actions', () => {
  it('requeue: removes entry, creates a NEW run', async () => {
    redis.lrange.mockResolvedValue([dead('d1')]);
    launch.mockResolvedValue({ id: 'new-1' });
    const res = await request(app).post('/ops/dlq/d1/requeue').set('Authorization', AUTH);
    expect(res.status).toBe(201);
    expect(redis.lrem).toHaveBeenCalledWith(expect.any(String), 1, dead('d1'));
    expect(launch).toHaveBeenCalledWith({ scenario: 'fast', vus: 1, duration: '10s' });
  });
  it('requeue: puts the entry back if the relaunch fails', async () => {
    redis.lrange.mockResolvedValue([dead('d1')]);
    launch.mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/ops/dlq/d1/requeue').set('Authorization', AUTH);
    expect(res.status).toBe(500);
    expect(redis.rpush).toHaveBeenCalledWith(expect.any(String), dead('d1'));
  });
  it('requeue + purge: 404 when not in DLQ', async () => {
    expect((await request(app).post('/ops/dlq/zzz/requeue').set('Authorization', AUTH)).status).toBe(404);
    expect((await request(app).delete('/ops/dlq/zzz').set('Authorization', AUTH)).status).toBe(404);
  });
  it('purge removes the entry', async () => {
    redis.lrange.mockResolvedValue([dead('d1')]);
    const res = await request(app).delete('/ops/dlq/d1').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.purged).toBe('d1');
  });
});

describe('POST /tests/:id/retry', () => {
  it('404 unknown, 409 while running, 201 + new run when failed', async () => {
    repo.findById.mockResolvedValueOnce(null);
    expect((await request(app).post('/tests/a/retry').set('Authorization', AUTH)).status).toBe(404);

    repo.findById.mockResolvedValueOnce({ id: 'a', status: 'running', config: {} });
    expect((await request(app).post('/tests/a/retry').set('Authorization', AUTH)).status).toBe(409);

    repo.findById.mockResolvedValueOnce({ id: 'a', status: 'failed', config: { scenario: 'slow' } });
    launch.mockResolvedValue({ id: 'b' });
    const res = await request(app).post('/tests/a/retry').set('Authorization', AUTH);
    expect(res.status).toBe(201);
    expect(launch).toHaveBeenCalledWith({ scenario: 'slow' });
  });
});

describe('GET /metrics', () => {
  it('exposes reaper and fenced counters without auth', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/control_api_reaped_total \d+/);
    expect(res.text).toMatch(/control_api_fenced_writes_total \d+/);
  });
});

describe('loadChaos', () => {
  it('aggregates kill + partition runs with nearest-rank stats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-'));
    const w = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
    w('chaos-run-01.json', { result: 'PASS', final_status: 'completed', mttr_seconds: 10, completion_seconds: 80, duplicate_completions: 0, env: { git_sha: 'aaa' } });
    w('chaos-run-02.json', { result: 'PASS', final_status: 'completed', mttr_seconds: 20, completion_seconds: 90, duplicate_completions: 0, env: { git_sha: 'bbb' } });
    w('partition-run-01.json', { result: 'FAIL', final_status: 'failed', mttr_seconds: null, in_dead_letter: true, duplicate_completions: 1 });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    fs.writeFileSync(path.join(dir, 'chaos-run-01.log'), 'ignored');
    const { runs, summary } = loadChaos(dir);
    expect(runs.map((r) => r.kind)).toEqual(['chaos-run', 'chaos-run', 'partition-run']);
    expect(summary).toMatchObject({ runs: 3, passed: 2, lost_jobs: 1, duplicate_completions: 1 });
    expect(summary.mttr_seconds).toEqual({ min: 10, p50: 10, p95: 20, max: 20 });
    expect(summary.git_shas).toEqual(['aaa', 'bbb']);
  });
  it('missing dir -> empty, no throw', () => {
    expect(loadChaos('/nonexistent-dir-xyz')).toMatchObject({ runs: [], summary: null });
  });
});
