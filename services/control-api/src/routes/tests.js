'use strict';

const router     = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const repo       = require('../db/repositories/test-run-repo');
const producer   = require('../queue/redis-producer');
const auth       = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const validate   = require('../middleware/validate');
const logger     = require('../logger');

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

    const updated = await repo.cancel(req.params.id);
    logger.info('Test run cancelled', { id: req.params.id });
    return res.json(updated);
  } catch (err) {
    logger.error('DELETE /tests/:id error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
