CREATE INDEX IF NOT EXISTS idx_test_runs_status         ON test_runs(status);
CREATE INDEX IF NOT EXISTS idx_test_runs_created_at     ON test_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_idempotency_key ON test_runs(idempotency_key);
