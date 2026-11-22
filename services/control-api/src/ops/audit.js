'use strict';

// Append-only (capped) record of operator actions: who did what, to what, and whether it worked.
const producer = require('../queue/redis-producer');
const logger   = require('../logger');

const KEY = 'ops:audit';
const KEEP = 200;

async function record(req, action, detail = {}, result = 'ok') {
  const entry = { at: new Date().toISOString(), actor: (req.user && req.user.sub) || 'unknown', action, detail, result };
  logger.warn('ops_action', entry);
  try {
    const redis = producer.getClient();
    await redis.lpush(KEY, JSON.stringify(entry));
    await redis.ltrim(KEY, 0, KEEP - 1);
  } catch (err) { logger.error('audit write failed', { error: err.message }); }
  return entry;
}

async function list(n = 50) {
  const raws = await producer.getClient().lrange(KEY, 0, n - 1);
  return raws.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

module.exports = { record, list, KEY };
