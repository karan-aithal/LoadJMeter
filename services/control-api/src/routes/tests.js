'use strict';

const router     = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const repo       = require('../db/repositories/test-run-repo');
const producer   = require('../queue/redis-producer');
const auth       = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const validate   = require('../middleware/validate');
const logger     = require('../logger');
const metrics    = require('../metrics');

const intOrNull = (v) => (Number.isInteger(v) ? v : null);

// The row exists (checked by the caller) but the write was refused: the run is terminal (finished/cancelled) or
// the writer's epoch is older than the current owner's. Either way the worker must stop acting on this job.
function fenced(req, res, run, epoch) {
  metrics.inc('fenced_writes_total');
  logger.warn('fenced_write', { jobId: req.params.id, epoch, rowEpoch: run.epoch, rowStatus: run.status, path: req.path });
  return res.status(409).json({ error: 'fenced', status: run.status, epoch: run.epoch });
}

// POST /tests — create + enqueue
router.post('/', auth, idempotency, validate, async (req, res) => {
  try {
    // Idempotent: return existing run if key already used
    const existing = await repo.findByIdempotencyKey(req.idempotencyKey);
    if (existing) {
      logger.info('Idempotent return', { id: existing.id });
      return res.status(200).json(existing);
    }

    const id  = uuidv4();
    const run = await repo.create({ id, idempotencyKey: req.idempotencyKey, config: req.body });
    await producer.enqueue({ id, config: req.body, createdAt: run.created_at });
    logger.info('Test run created + enqueued', { id });
    return res.status(201).json(run);
  } catch (err) {
    logger.error('POST /tests error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /tests — paginated list
router.get('/', auth, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  try {
    return res.json(await repo.list({ page, limit }));
  } catch (err) {
    logger.error('GET /tests error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /tests/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const run = await repo.findById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    return res.json(run);
  } catch (err) {
    logger.error('GET /tests/:id error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /tests/:id — cancel
router.delete('/:id', auth, async (req, res) => {
  try {
    const run = await repo.findById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });

    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return res.status(409).json({ error: `Cannot cancel: status is '${run.status}'` });
    }

    await producer.markCancelled(req.params.id); // tombstone first: stops reaper/worker re-queues racing this cancel
    const updated = await repo.cancel(req.params.id);
    if (!updated) return res.status(409).json({ error: 'Cannot cancel: run just finished' });
    logger.info('Test run cancelled', { id: req.params.id });
    return res.json(updated);
  } catch (err) {
    logger.error('DELETE /tests/:id error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /tests/:id/status — internal worker status update
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const run = await repo.findById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });

    const {
      status,
      verdict,
      workerId,
      errorMessage,
      startedAt,
      completedAt,
    } = req.body;
    const epoch = intOrNull(req.body.epoch);

    const updated = await repo.updateStatus(req.params.id, {
      status,
      verdict,
      workerId,
      errorMessage,
      startedAt,
      completedAt,
      epoch,
      nextEpoch: intOrNull(req.body.nextEpoch),
    });
    if (!updated) return fenced(req, res, run, epoch);

    return res.json(updated);
  } catch (err) {
    logger.error('PATCH /tests/:id/status error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /tests/:id/heartbeat — internal worker heartbeat
router.post('/:id/heartbeat', auth, async (req, res) => {
  try {
    const run = await repo.findById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });

    const workerId = req.body.workerId || req.query.workerId || null;
    const epoch = intOrNull(req.body.epoch);
    const updated = await repo.updateStatus(req.params.id, { workerId, epoch });
    if (!updated) return fenced(req, res, run, epoch);

    return res.json({ status: 'ok', id: updated.id, updatedAt: updated.updated_at });
  } catch (err) {
    logger.error('POST /tests/:id/heartbeat error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
