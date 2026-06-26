'use strict';

// Source of truth for Redis queue key names.
// Workers and control-api must use the same keys.
module.exports = {
  JOBS_PENDING:     process.env.JOBS_PENDING_QUEUE || 'jobs:pending',
  JOBS_DEAD_LETTER: process.env.JOBS_DL_QUEUE     || 'jobs:dead-letter',
  JOB_LOCK_PREFIX:  'job:lock:',
  HEARTBEAT_PREFIX: 'job:heartbeat:',
};
