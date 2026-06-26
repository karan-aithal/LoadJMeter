'use strict';

function log(level, msg, meta) {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, msg, ...meta }) + '\n'
  );
}

module.exports = {
  info:  (msg, meta = {}) => log('INFO',  msg, meta),
  warn:  (msg, meta = {}) => log('WARN',  msg, meta),
  error: (msg, meta = {}) => log('ERROR', msg, meta),
};
