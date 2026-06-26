'use strict';

const router = require('express').Router();

// Liveness: process is alive — no dep checks
router.get('/', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

module.exports = router;
