'use strict';

const { v4: uuidv4 } = require('uuid');
const repo     = require('./db/repositories/test-run-repo');
const producer = require('./queue/redis-producer');

// Create a brand-new run from an existing config and enqueue it. Used by retry and DLQ requeue: a fresh run
// (new id, epoch 0) means no fencing-epoch games with the old, terminal row.
async function launch(config, idempotencyKey = `ops-${uuidv4()}`) {
  const id  = uuidv4();
  const run = await repo.create({ id, idempotencyKey, config });
  await producer.enqueue({ id, config, createdAt: run.created_at });
  return run;
}

module.exports = { launch };
