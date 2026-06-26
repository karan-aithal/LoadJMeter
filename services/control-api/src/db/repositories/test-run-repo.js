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

async function updateStatus(id, { status, verdict, workerId, errorMessage, startedAt, completedAt }) {
  const { rows } = await pool.query(
    `UPDATE test_runs
     SET status        = COALESCE($2,  status),
         verdict       = COALESCE($3,  verdict),
         worker_id     = COALESCE($4,  worker_id),
         error_message = COALESCE($5,  error_message),
         started_at    = COALESCE($6,  started_at),
         completed_at  = COALESCE($7,  completed_at),
         updated_at    = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status, verdict, workerId, errorMessage, startedAt, completedAt]
  );
  return rows[0] || null;
}

async function cancel(id) {
  return updateStatus(id, { status: 'cancelled' });
}

module.exports = { create, findById, findByIdempotencyKey, list, updateStatus, cancel };
