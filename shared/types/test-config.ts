export interface TestConfig {
  scenario: 'base' | 'fast' | 'slow' | 'cpu-heavy';
  vus: number;       // 1–500
  duration: string;  // k6 format: 30s | 5m | 1h
  rampUp?: string;
  rampDown?: string;
  sutUrl?: string;
  region?: string;   // Phase 9: us-east | eu-west | ap-south
}

export type TestStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TestVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;

export interface TestRun {
  id: string;
  idempotencyKey: string;
  status: TestStatus;
  config: TestConfig;
  verdict: TestVerdict;
  workerId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
