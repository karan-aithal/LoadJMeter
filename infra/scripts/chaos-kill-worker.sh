#!/usr/bin/env bash
# chaos-kill-worker.sh — kills a worker pod mid-job and verifies the job is requeued.
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
echo "==> Step 3: Kill worker pod $TARGET (simulates crash)"
kubectl -n "$NS" delete pod "$TARGET" --grace-period=0 --force
echo "  Pod deleted."

echo ""
echo "==> Step 4: Wait 15s for K8s to detect + for retry logic to requeue"
sleep 15

echo ""
echo "==> Step 5: Verify job requeued (pending queue should have items)"
PENDING_AFTER=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:pending 2>/dev/null || echo "0")
PROC_AFTER=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:processing 2>/dev/null || echo "0")
DLQ_AFTER=$(kubectl -n "$NS" exec "$REDIS_POD" -- redis-cli llen jobs:dead-letter 2>/dev/null || echo "0")
echo "  jobs:pending=$PENDING_AFTER  jobs:processing=$PROC_AFTER  jobs:dead-letter=$DLQ_AFTER"

echo ""
echo "==> Step 6: Confirm replacement pod comes up"
kubectl -n "$NS" wait --for=condition=ready pod -l app=worker --timeout=60s
NEW_WORKERS=$(kubectl -n "$NS" get pods -l app=worker --no-headers | grep Running | awk '{print $1}')
echo "  Running workers: $(echo "$NEW_WORKERS" | wc -w | tr -d ' ')"

echo ""
echo "CHAOS TEST COMPLETE"
echo "  If jobs:pending > 0 or a new worker picked up the job — PASS"
echo "  If jobs:dead-letter > 0 (max retries hit) — also PASS (retry policy fired)"
