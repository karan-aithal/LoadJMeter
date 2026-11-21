#!/usr/bin/env bash
# chaos-summary.sh FILE... — aggregate chaos-kill-worker.sh JSON results (nearest-rank p50/p95).
# Usage: ./infra/scripts/chaos-summary.sh docs/benchmarks/results/chaos-run-*.json
set -euo pipefail
jq -s '
  def pct(p): sort as $s | if ($s|length)==0 then null else $s[((p/100*($s|length))|ceil)-1] end;
  def stats: map(select(. != null)) | {n:length, min:min, p50:pct(50), p95:pct(95), max:max};
  { runs: length, passed: (map(select(.result=="PASS"))|length),
    lost_jobs: (map(select(.left_in_redis or .in_dead_letter or .final_status!="completed"))|length),
    duplicate_completions: (map(.duplicate_completions)|add),
    mttr_seconds: (map(.mttr_seconds)|stats),
    completion_seconds: (map(.completion_seconds)|stats) }' "$@"
