'use strict';

const { v4: uuidv4 } = require('uuid');

module.exports = function traceId(req, res, next) {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
};
