'use strict';

const pool = require('../client');

async function create({ id, idempotencyKey, config }) {
  const { rows } = await pool.query(
    `INSERT INTO test_runs (id, idempotency_key, config)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, idempotencyKey, JSON.stringify(config)]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM test_runs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function findByIds(ids) {
  const { rows } = await pool.query('SELECT * FROM test_runs WHERE id = ANY($1::uuid[])', [ids]);
  return rows;
}

async function findByIdempotencyKey(key) {
  const { rows } = await pool.query(
    'SELECT * FROM test_runs WHERE idempotency_key = $1', [key]
  );
  return rows[0] || null;
}

async function list({ page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;
  const { rows } = await pool.query(
    'SELECT * FROM test_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM test_runs');
  return { items: rows, total: parseInt(countRows[0].count, 10), page, limit };
}

// Terminal rows never change again, and a writer holding an old epoch is fenced out.
//   epoch      : the writer's fencing token. Applied only if epoch >= row.epoch (omit for unfenced callers, e.g. users).
//   nextEpoch  : epoch to store (default: the writer's own). A worker re-queueing its job passes epoch+1 so
//                that its own later writes, and any stale copy of it, are rejected.
// Returns null if the row is missing, terminal, or the writer is fenced; callers tell those apart via findById.
async function updateStatus(id, { status, verdict, workerId, errorMessage, startedAt, completedAt, epoch, nextEpoch }) {
  const { rows } = await pool.query(
    `UPDATE test_runs
     SET status        = COALESCE($2,  status),
         verdict       = COALESCE($3,  verdict),
         worker_id     = COALESCE($4,  worker_id),
         error_message = COALESCE($5,  error_message),
         started_at    = COALESCE($6,  started_at),
         completed_at  = COALESCE($7,  completed_at),
         epoch         = GREATEST(epoch, COALESCE($9::int, $8::int, epoch)),
         updated_at    = NOW()
     WHERE id = $1
       AND status NOT IN ('completed', 'failed', 'cancelled')
       AND ($8::int IS NULL OR $8::int >= epoch)
     RETURNING *`,
    [id, status, verdict, workerId, errorMessage, startedAt, completedAt, epoch ?? null, nextEpoch ?? null]
  );
  return rows[0] || null;
}

// Reaper step 1: take ownership in the DB BEFORE touching Redis. Succeeds only if the run is still 'running'
// and silent since cutoff, so a worker that finished or heartbeated in the meantime wins and nothing is queued.
// On success the previous owner (epoch < newEpoch) is fenced out. `dead` marks the run failed in the same
// statement (retries exhausted), otherwise it goes back to 'pending'.
async function claimStale(id, { newEpoch, cutoff, errorMessage, dead = false, completedAt = null }) {
  const { rows } = await pool.query(
    `UPDATE test_runs
     SET status = $5, verdict = COALESCE($6, verdict), completed_at = COALESCE($7::timestamptz, completed_at),
         epoch = $2, error_message = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'running' AND epoch < $2 AND updated_at < $4::timestamptz
     RETURNING *`,
    [id, newEpoch, errorMessage, cutoff, dead ? 'failed' : 'pending', dead ? 'FAIL' : null, completedAt]
  );
  return rows[0] || null;
}

async function cancel(id) {
  return updateStatus(id, { status: 'cancelled' });
}

module.exports = { create, findById, findByIds, findByIdempotencyKey, list, updateStatus, claimStale, cancel };
