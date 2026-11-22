'use strict';

// Worker fleet over Redis. Each worker refreshes `ops:worker:<id>` (TTL) and a score in the `ops:workers` zset every
// ~2s; commands go out on one pub/sub channel and the addressed worker (or '*') acts on them.
const CHANNEL = 'ops:worker:cmd';
const PREFIX  = 'ops:worker:';
const INDEX   = 'ops:workers';
const SEEN_MS = 60000;           // older than this = gone (a crashed worker lingers this long as "stale")
const COMMANDS = ['pause', 'resume', 'drain', 'crash', 'partition'];
const DESTRUCTIVE = new Set(['drain', 'crash', 'partition']);

async function list(redis, now = Date.now()) {
  await redis.zremrangebyscore(INDEX, 0, now - SEEN_MS);
  const ids = await redis.zrange(INDEX, 0, -1);
  if (!ids.length) return [];
  const raws = await redis.mget(ids.map((i) => PREFIX + i));
  return raws.map((r, i) => {
    try { const w = JSON.parse(r); return { ...w, ageMs: now - w.lastSeen, stale: now - w.lastSeen > 6000 }; }
    catch { return { workerId: ids[i], state: 'unknown', lastSeen: 0, ageMs: now, stale: true }; }
  }).filter(Boolean);
}

async function command(redis, target, cmd, args = {}) {
  return redis.publish(CHANNEL, JSON.stringify({ target, cmd, args, at: Date.now() }));
}

module.exports = { list, command, CHANNEL, PREFIX, INDEX, COMMANDS, DESTRUCTIVE };
