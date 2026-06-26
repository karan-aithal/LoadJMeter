'use strict';

const router = require('express').Router();
const logger = require('../logger/logger');

// Iterative fib — avoids stack overflow on large n
function fibonacci(n) {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return b;
}

const FIB_N = parseInt(process.env.FIB_N || '35', 10);

router.get('/', (req, res) => {
  logger.info('cpu-heavy endpoint hit', { traceId: req.traceId, fibN: FIB_N });
  const result = fibonacci(FIB_N);
  res.json({ status: 'ok', endpoint: 'cpu-heavy', input: FIB_N, result: result.toString(), traceId: req.traceId });
});

module.exports = router;
