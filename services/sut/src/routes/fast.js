'use strict';

const router = require('express').Router();
const logger = require('../logger/logger');

router.get('/', (req, res) => {
  logger.info('fast endpoint hit', { traceId: req.traceId });
  res.json({ status: 'ok', endpoint: 'fast', traceId: req.traceId });
});

module.exports = router;
