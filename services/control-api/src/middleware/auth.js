'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../logger');

module.exports = function authenticate(req, res, next) {
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && process.env.API_KEY && apiKeyHeader === process.env.API_KEY) {
    req.user = { sub: 'internal-worker', role: 'worker' };
    return next();
  }

  const header = req.headers['authorization'] || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('JWT_SECRET not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  try {
    req.user = jwt.verify(token, secret);
    next();
  } catch (err) {
    logger.warn('JWT verify failed', { error: err.message });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
