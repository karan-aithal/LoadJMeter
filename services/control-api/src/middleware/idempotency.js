'use strict';

module.exports = function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (!key || typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({ error: 'Idempotency-Key header required' });
  }
  if (key.length > 255) {
    return res.status(400).json({ error: 'Idempotency-Key exceeds 255 characters' });
  }

  req.idempotencyKey = key.trim();
  next();
};
