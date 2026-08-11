'use strict';

const express = require('express');
const {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  httpErrorsTotal,
  httpInFlight,
} = require('./metrics/prometheus');
const traceId = require('./middleware/trace-id');
const logger = require('./logger/logger');

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

app.use(express.json());
app.use(traceId);

// Per-request instrumentation
app.use((req, res, next) => {
  httpInFlight.inc();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    end(labels);
    httpRequestsTotal.inc(labels);
    if (res.statusCode >= 500) {
      httpErrorsTotal.inc({ method: req.method, route });
    }
    httpInFlight.dec();
  });
  next();
});

app.use('/fast',      require('./routes/fast'));
app.use('/slow',      require('./routes/slow'));
app.use('/cpu-heavy', require('./routes/cpu-heavy'));
app.use('/healthz',   require('./health/healthz'));
app.use('/readyz',    require('./health/readyz'));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('unhandled error', { traceId: req.traceId, error: err.message });
  res.status(500).json({ error: 'internal server error', traceId: req.traceId });
});

const server = app.listen(PORT, () => {
  logger.info('SUT started', { port: PORT });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});

module.exports = { app };
