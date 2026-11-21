'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../logger');

// Role gate, use after authenticate. Workers authenticate with x-api-key (role 'worker'), UI users get a
// JWT (role 'operator'); neither may call the other's routes.
function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });
}

function authenticate(req, res, next) {
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
}

module.exports = authenticate;
module.exports.requireRole = requireRole;
