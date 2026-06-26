'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('./client');
const logger = require('../logger');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1', [file]
      );
      if (rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info('Running migration', { file });
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
      await client.query('COMMIT');
      logger.info('Migration applied', { file });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
