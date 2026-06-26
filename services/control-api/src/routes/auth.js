'use strict';

const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const logger = require('../logger');

// POST /auth/token — exchange API key for a signed JWT
router.post('/token', (req, res) => {
  const { apiKey } = req.body;
  const expected   = process.env.API_KEY;
  const secret     = process.env.JWT_SECRET;

  if (!expected || !secret) {
    logger.error('API_KEY or JWT_SECRET not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!apiKey || apiKey !== expected) {
    logger.warn('Failed auth attempt');
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const token = jwt.sign(
    { sub: 'api-user', role: 'operator' },
    secret,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );

  logger.info('JWT issued');
  return res.json({ token });
});

module.exports = router;
