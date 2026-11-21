#!/usr/bin/env bash
# chaos-matrix.sh — the multi-worker kill matrix: different scenarios, VU counts, durations, worker counts and CPU
# requests, with the killed worker rotating over the jobs. Results: docs/benchmarks/results/chaos-multi-run-NN.json
#   A (6 runs): 3 workers @250m  fast:2:45s  slow:5:60s  cpu-heavy:10:45s   victim = job 1,2,3,1,2,3
#   B (4 runs): 2 workers @400m  fast:10:90s slow:2:30s                      victim = job 1,2,1,2
# (2 workers @500m do not fit the 3.8-CPU CRC node: ~2.8 CPU is platform overhead, ~1.0 CPU is left for workers.)
# SKIP_A=1 runs only B (numbered from 07). Run from a clean tree (each result records the git SHA). Usage: infra/scripts/chaos-matrix.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$ROOT/.okd-shim" && ln -sf "$(command -v oc)" "$ROOT/.okd-shim/kubectl"
export PATH="$ROOT/.okd-shim:$PATH" NAMESPACE=${NAMESPACE:-loadtest-system}
n=0
run() {   # workers cpu victim jobs...
  local w=$1 cpu=$2 v=$3; shift 3; n=$((n+1)); local out; out=$(printf 'docs/benchmarks/results/chaos-multi-run-%02d.json' "$n")
  WORKERS=$w CPU_REQUEST=$cpu VICTIM=$v JOBS="$*" OUT="$ROOT/$out" bash "$HERE/chaos-kill-multi.sh" >/dev/null || echo "run $n did not PASS"
}
if [[ -n ${SKIP_A:-} ]]; then n=6; else for v in 1 2 3 1 2 3; do run 3 250m "$v" fast:2:45s slow:5:60s cpu-heavy:10:45s; done; fi
for v in 1 2 1 2;     do run 2 400m "$v" fast:10:90s slow:2:30s; done
bash "$HERE/chaos-summary.sh" "$ROOT"/docs/benchmarks/results/chaos-multi-run-*.json
