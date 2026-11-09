#!/usr/bin/env bash
# chaos-kill-worker.sh — kills a worker pod mid-job, times how long the reaper takes to requeue it.
# Phase 6 chaos check: confirms dead-letter/retry mechanism survives pod loss.
# Usage:
#   ./infra/scripts/chaos-kill-worker.sh
# Requires: kubectl context pointing at loadtest-system.
set -euo pipefail

NS=${NAMESPACE:-loadtest-system}

echo "==> Step 1: Confirm at least one worker is running"
WORKERS=$(kubectl -n "$NS" get pods -l app=worker --no-headers 2>/dev/null | grep Running | awk '{print $1}')
if [[ -z "$WORKERS" ]]; then
  echo "ERROR: No running worker pods in $NS" >&2
  exit 1
fi
TARGET=$(echo "$WORKERS" | head -1)
echo "  Target pod: $TARGET"

echo ""
echo "==> Step 2: Record queue lengths before kill"
REDIS_POD=$(kubectl -n "$NS" get pods -l app=redis -o jsonpath='{.items[0].metadata.name}')
PENDING_BEFORE=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:pending 2>/dev/null || echo "0")
PROC_BEFORE=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:processing 2>/dev/null || echo "0")
echo "  jobs:pending=$PENDING_BEFORE  jobs:processing=$PROC_BEFORE"

echo ""
echo "==> Step 3: Require an in-flight job (enqueue a long test first if none)"
RAW=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli lrange jobs:processing 0 0 | head -1)
if [[ -z "$RAW" ]]; then
  echo "ERROR: jobs:processing is empty - start a long test, then re-run" >&2
  exit 1
fi
echo "  Tracking: $RAW"

echo ""
echo "==> Step 4: Kill worker pod $TARGET (simulates crash)"
START=$(date +%s)
kubectl -n "$NS" delete pod "$TARGET" --grace-period=0 --force
echo "  Pod deleted."

echo ""
echo "==> Step 5: Poll until reaper moves the job out of jobs:processing (timeout ${TIMEOUT:-90}s)"
while kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli lrange jobs:processing 0 -1 | grep -qxF -- "$RAW"; do
  if (( $(date +%s) - START > ${TIMEOUT:-90} )); then
    echo "FAIL: job still stuck in jobs:processing after ${TIMEOUT:-90}s" >&2
    exit 1
  fi
  sleep 1
done
ELAPSED=$(( $(date +%s) - START ))
PENDING_AFTER=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:pending 2>/dev/null || echo "0")
PROC_AFTER=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:processing 2>/dev/null || echo "0")
DLQ_AFTER=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:dead-letter 2>/dev/null || echo "0")
echo "  jobs:pending=$PENDING_AFTER  jobs:processing=$PROC_AFTER  jobs:dead-letter=$DLQ_AFTER"

echo ""
echo "==> Step 6: Confirm replacement pod comes up"
kubectl -n "$NS" wait --for=condition=ready pod -l app=worker --timeout=60s

echo ""
echo "CHAOS TEST PASS"
echo "  Recovered from hard worker kill in ${ELAPSED} s"
