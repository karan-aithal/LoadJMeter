'use strict';

const router = require('express').Router();
const { register } = require('../metrics/prometheus');

// Readiness: can serve traffic — metrics registry must be initialised
router.get('/', (req, res) => {
  if (register) {
    res.status(200).json({ status: 'ready' });
  } else {
    res.status(503).json({ status: 'not ready', reason: 'metrics registry not initialised' });
  }
});

module.exports = router;
