-- Fencing token: a worker's writes are accepted only if its epoch >= this value.
-- The reaper (or a worker retrying its own job) bumps it, which locks out the previous owner.
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS epoch INT NOT NULL DEFAULT 0;
