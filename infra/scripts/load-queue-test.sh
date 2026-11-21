#!/usr/bin/env bash
# load-queue-test.sh — push N jobs into the queue and watch KEDA scale workers up.
# Usage:
#   TARGET=5 ./infra/scripts/load-queue-test.sh [N_JOBS] [VUS] [DURATION]
# KEDA counts only jobs:pending and a worker pops one job at once, so reaching
# TARGET replicas needs N_JOBS >= TARGET+1 (default 6).
# Requires: kubectl context pointing at loadtest-system, redis-cli OR port-forward.
set -euo pipefail

NS=${NAMESPACE:-loadtest-system}
N_JOBS=${1:-6}
TARGET=${TARGET:-5}
VUS=${2:-10}
DURATION=${3:-30s}

echo "==> Pushing $N_JOBS jobs into queue (VUs=$VUS duration=$DURATION)"

. "$(dirname "$0")/lib-push-jobs.sh"
push_jobs "$N_JOBS" "$VUS" "$DURATION"

(( N_JOBS > TARGET )) || echo "WARN: N_JOBS=$N_JOBS <= TARGET=$TARGET, target likely unreachable" >&2

echo ""
echo "==> Watching scale-up (t0 = last POST, 1s resolution, 120s timeout)"
t0=$(date +%s.%N)
t_sched="" t_ready="" last="" MAXUNSCHED=0 MAXREADY=0
for _ in $(seq 1 120); do
  read -r SCHED READY < <(kubectl -n "$NS" get deploy worker \
    -o jsonpath='{.spec.replicas} {.status.readyReplicas}' 2>/dev/null || true) || true  # read returns 1 (no trailing newline) and would trip set -e
  SCHED=${SCHED:-0} READY=${READY:-0}
  # the metric KEDA scales on: LLEN jobs:pending (jobs already popped by a worker no longer count)
  PEND=$(kubectl -n "$NS" exec deploy/redis -- redis-cli LLEN jobs:pending 2>/dev/null || echo "?")
  now=$(echo "$(date +%s.%N) - $t0" | bc)
  [[ "$SCHED/$READY/$PEND" != "$last" ]] && printf "  +%5.1fs desired=%s ready=%s pending=%s\n" "$now" "$SCHED" "$READY" "$PEND"
  last="$SCHED/$READY/$PEND"
  (( READY > MAXREADY )) && MAXREADY=$READY
  if (( SCHED > READY )); then  # lagging: note pods stuck Pending (e.g. Insufficient cpu) while we still see them
    U=$(kubectl -n "$NS" get pods -l app=worker --field-selector=status.phase=Pending --no-headers 2>/dev/null | wc -l)
    (( U > MAXUNSCHED )) && MAXUNSCHED=$U
  fi
  [[ -z "$t_sched" && $SCHED -ge $TARGET ]] && t_sched=$now
  [[ -z "$t_ready" && $READY -ge $TARGET ]] && { t_ready=$now; break; }
  sleep 1
done
if [[ -z "$t_ready" && $MAXUNSCHED -gt 0 ]]; then
  echo "CONSTRAINED: up to $MAXUNSCHED worker pod(s) were Pending (unschedulable); at most $MAXREADY of $TARGET were Ready at once on the node:"
  kubectl -n "$NS" get events --field-selector=reason=FailedScheduling --sort-by=.lastTimestamp 2>/dev/null \
    | tail -1 | cut -c1-200
fi
fmt() { [[ -n "$1" ]] && printf "%.1fs" "$1" || echo "NOT REACHED"; }
echo "RESULT time to $TARGET desired replicas: $(fmt "$t_sched")"
echo "RESULT time to $TARGET Ready replicas:   $(fmt "$t_ready")"

echo ""
echo "==> Waiting for queue to drain (60s)..."
sleep 60

echo "==> Watching KEDA scale-down (90s)..."
for _ in $(seq 1 9); do
  echo "  worker ready: $(kubectl -n "$NS" get deploy worker -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"
  sleep 10
done

echo "DONE"
