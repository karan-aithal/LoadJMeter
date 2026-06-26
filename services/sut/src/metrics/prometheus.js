'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpErrorsTotal = new client.Counter({
  name: 'http_errors_total',
  help: 'Total HTTP errors (5xx)',
  labelNames: ['method', 'route'],
  registers: [register],
});

const httpInFlight = new client.Gauge({
  name: 'http_in_flight_requests',
  help: 'Number of in-flight HTTP requests',
  registers: [register],
});

module.exports = { register, httpRequestDuration, httpRequestsTotal, httpErrorsTotal, httpInFlight };
