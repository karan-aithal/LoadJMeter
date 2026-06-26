CREATE TABLE IF NOT EXISTS test_runs (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key  VARCHAR(255) UNIQUE NOT NULL,
  status           VARCHAR(50)  NOT NULL DEFAULT 'pending',
  config           JSONB        NOT NULL,
  verdict          VARCHAR(20),
  worker_id        VARCHAR(255),
  error_message    TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);
