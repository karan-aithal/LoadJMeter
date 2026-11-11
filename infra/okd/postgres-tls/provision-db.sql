-- Idempotent. Run as the postgres superuser, optionally with: psql -v pw="$PASSWORD" -f provision-db.sql
-- (pw sets/rotates the loadjmeter password using SCRAM; omit to leave the current one untouched.)
SELECT 'CREATE ROLE loadjmeter LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loadjmeter') \gexec
SELECT 'CREATE DATABASE loadjmeter OWNER loadjmeter'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'loadjmeter') \gexec

\if :{?pw}
  SET password_encryption = 'scram-sha-256';
  ALTER ROLE loadjmeter PASSWORD :'pw';
\endif

\connect loadjmeter
-- Pre-create so the app role needs no extra privilege at migration time (001_init.sql also does IF NOT EXISTS).
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
GRANT ALL ON SCHEMA public TO loadjmeter;

-- A SCRAM hash is required by the scram-sha-256 pg_hba rule.
SELECT rolname, left(rolpassword, 13) AS hash_prefix FROM pg_authid WHERE rolname = 'loadjmeter';
