'use strict';

const router = require('express').Router();
const logger = require('../logger/logger');

const SLOW_DELAY_MS = parseInt(process.env.SLOW_DELAY_MS || '200', 10);

router.get('/', (req, res) => {
  logger.info('slow endpoint hit', { traceId: req.traceId, delayMs: SLOW_DELAY_MS });
  setTimeout(() => {
    res.json({ status: 'ok', endpoint: 'slow', delayMs: SLOW_DELAY_MS, traceId: req.traceId });
  }, SLOW_DELAY_MS);
});

module.exports = router;
