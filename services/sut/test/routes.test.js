'use strict';

const request = require('supertest');
const { app } = require('../src/index');

describe('SUT routes', () => {
  it('GET /fast → 200 with endpoint field', async () => {
    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toBe('fast');
  });

  it('GET /slow → 200 with endpoint field', async () => {
    const res = await request(app).get('/slow');
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toBe('slow');
  });

  it('GET /cpu-heavy → 200 with result field', async () => {
    const res = await request(app).get('/cpu-heavy');
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toBe('cpu-heavy');
    expect(res.body.result).toBeDefined();
  });

  it('GET /healthz → 200 alive', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('GET /readyz → 200 ready', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('GET /metrics → 200 with prometheus text', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('http_in_flight_requests');
  });

  it('propagates x-trace-id header', async () => {
    const res = await request(app).get('/fast').set('x-trace-id', 'test-trace-abc');
    expect(res.headers['x-trace-id']).toBe('test-trace-abc');
    expect(res.body.traceId).toBe('test-trace-abc');
  });

  it('generates trace-id when header absent', async () => {
    const res = await request(app).get('/fast');
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
