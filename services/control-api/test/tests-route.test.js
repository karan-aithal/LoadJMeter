'use strict';

// Mock heavy deps before any require
jest.mock('../src/db/repositories/test-run-repo');
jest.mock('../src/queue/redis-producer');
jest.mock('../src/db/migrate', () => ({ runMigrations: jest.fn().mockResolvedValue() }));
jest.mock('../src/db/client',  () => ({ query: jest.fn(), connect: jest.fn() }));

process.env.JWT_SECRET = 'test-secret-minimum-32-chars-long!!';
process.env.API_KEY    = 'test-api-key';

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { app }  = require('../src/index');
const repo     = require('../src/db/repositories/test-run-repo');
const producer = require('../src/queue/redis-producer');

const TOKEN = jwt.sign(
  { sub: 'api-user', role: 'operator' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);
const AUTH = `Bearer ${TOKEN}`;

// ── Auth ──────────────────────────────────────────────────────────────────────
describe('POST /auth/token', () => {
  it('200 + token on valid API key', async () => {
    const res = await request(app).post('/auth/token').send({ apiKey: 'test-api-key' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('401 on wrong API key', async () => {
    const res = await request(app).post('/auth/token').send({ apiKey: 'wrong' });
    expect(res.status).toBe(401);
  });
});

// ── POST /tests ───────────────────────────────────────────────────────────────
describe('POST /tests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('401 without auth header', async () => {
    const res = await request(app)
      .post('/tests')
      .set('Idempotency-Key', 'k1')
      .send({ scenario: 'fast', vus: 10, duration: '30s' });
    expect(res.status).toBe(401);
  });

  it('400 without Idempotency-Key header', async () => {
    const res = await request(app)
      .post('/tests')
      .set('Authorization', AUTH)
      .send({ scenario: 'fast', vus: 10, duration: '30s' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
  });

  it('400 on vus out of range', async () => {
    const res = await request(app)
      .post('/tests')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'k2')
      .send({ scenario: 'fast', vus: 9999, duration: '30s' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/vus/)]));
  });

  it('400 on invalid scenario', async () => {
    const res = await request(app)
      .post('/tests')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'k3')
      .send({ scenario: 'nuke-prod', vus: 10, duration: '30s' });
    expect(res.status).toBe(400);
  });

  it('400 on bad duration format', async () => {
    const res = await request(app)
      .post('/tests')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'k4')
      .send({ scenario: 'fast', vus: 10, duration: '30seconds' });
    expect(res.status).toBe(400);
  });

  it('201 creates and enqueues a new run', async () => {
    repo.findByIdempotencyKey.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: 'uuid-1', status: 'pending', created_at: new Date() });
    producer.enqueue.mockResolvedValue(true);

    const res = await request(app)
      .post('/tests')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'k5')
      .send({ scenario: 'fast', vus: 10, duration: '30s' });

    expect(res.status).toBe(201);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(producer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('200 (idempotent) on duplicate key', async () => {
    const existing = { id: 'uuid-2', status: 'pending' };
    repo.findByIdempotencyKey.mockResolvedValue(existing);

    const res = await request(app)
      .post('/tests')
      .set('Authorization', AUTH)
      .set('Idempotency-Key', 'k5')  // same key
      .send({ scenario: 'fast', vus: 10, duration: '30s' });

    expect(res.status).toBe(200);
    expect(repo.create).not.toHaveBeenCalled();
    expect(producer.enqueue).not.toHaveBeenCalled();
  });
});

// ── GET /tests ────────────────────────────────────────────────────────────────
describe('GET /tests', () => {
  it('401 without auth', async () => {
    expect((await request(app).get('/tests')).status).toBe(401);
  });

  it('200 with paginated result', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    const res = await request(app).get('/tests').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
  });
});

// ── GET /tests/:id ────────────────────────────────────────────────────────────
describe('GET /tests/:id', () => {
  it('404 for unknown id', async () => {
    repo.findById.mockResolvedValue(null);
    expect(
      (await request(app).get('/tests/unknown').set('Authorization', AUTH)).status
    ).toBe(404);
  });

  it('200 returns run', async () => {
    repo.findById.mockResolvedValue({ id: 'uuid-3', status: 'running' });
    const res = await request(app).get('/tests/uuid-3').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('uuid-3');
  });
});

// ── DELETE /tests/:id ─────────────────────────────────────────────────────────
describe('DELETE /tests/:id', () => {
  it('404 for unknown id', async () => {
    repo.findById.mockResolvedValue(null);
    expect(
      (await request(app).delete('/tests/x').set('Authorization', AUTH)).status
    ).toBe(404);
  });

  it('200 cancels a pending run', async () => {
    repo.findById.mockResolvedValue({ id: 'uuid-4', status: 'pending' });
    repo.cancel.mockResolvedValue({ id: 'uuid-4', status: 'cancelled' });
    const res = await request(app).delete('/tests/uuid-4').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('409 when run is already completed', async () => {
    repo.findById.mockResolvedValue({ id: 'uuid-5', status: 'completed' });
    expect(
      (await request(app).delete('/tests/uuid-5').set('Authorization', AUTH)).status
    ).toBe(409);
  });
});
