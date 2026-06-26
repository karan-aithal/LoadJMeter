'use strict';

const express = require('express');
const logger  = require('./logger');
const { runMigrations } = require('./db/migrate');
const { setupOpenApi }  = require('./openapi/generate');

const app  = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

app.use(express.json());

// Health (no auth)
app.get('/healthz', (_req, res) => res.json({ status: 'alive' }));
app.get('/readyz',  (_req, res) => res.json({ status: 'ready' }));

// API routes
app.use('/auth',  require('./routes/auth'));
app.use('/tests', require('./routes/tests'));

// OpenAPI UI at /api-docs
setupOpenApi(app);

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    await runMigrations();
    logger.info('Migrations complete');
  } catch (err) {
    logger.error('Migration failed — aborting', { error: err.message });
    process.exit(1);
  }

  const server = app.listen(PORT, () =>
    logger.info('Control API started', { port: PORT })
  );

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) start();

module.exports = { app };
