#!/usr/bin/env bash
# load-queue-test.sh — push N jobs into the queue and watch KEDA scale workers up.
# Usage:
#   ./infra/scripts/load-queue-test.sh [N_JOBS] [VUS] [DURATION]
# Requires: kubectl context pointing at loadtest-system, redis-cli OR port-forward.
set -euo pipefail

NS=${NAMESPACE:-loadtest-system}
N_JOBS=${1:-5}
VUS=${2:-10}
DURATION=${3:-30s}
IDEMPOTENCY_PREFIX="load-test-$(date +%s)"

echo "==> Pushing $N_JOBS jobs into queue (VUs=$VUS duration=$DURATION)"

# Port-forward control-api for local access
API_PORT=14000
kubectl -n "$NS" port-forward svc/control-api "$API_PORT:4000" &
PF_PID=$!
sleep 2

BASE_URL="http://localhost:$API_PORT"

# Get JWT
TOKEN=$(curl -sf -X POST "$BASE_URL/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"apiKey\":\"$API_KEY\"}" | jq -r .token)

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: failed to obtain JWT — is API_KEY set?" >&2
  kill $PF_PID 2>/dev/null || true
  exit 1
fi

for i in $(seq 1 "$N_JOBS"); do
  IDEM_KEY="${IDEMPOTENCY_PREFIX}-job-${i}"
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL/tests" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Idempotency-Key: $IDEM_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"scenario\":\"fast\",\"vus\":$VUS,\"duration\":\"$DURATION\"}")
  echo "  job $i → HTTP $STATUS (idem-key: $IDEM_KEY)"
done

kill $PF_PID 2>/dev/null || true

echo ""
echo "==> Watching KEDA scale-up (30s)..."
for _ in $(seq 1 6); do
  PODS=$(kubectl -n "$NS" get pods -l app=worker --no-headers 2>/dev/null | wc -l)
  echo "  worker pods: $PODS"
  sleep 5
done

echo ""
echo "==> Waiting for queue to drain (60s)..."
sleep 60

echo "==> Watching KEDA scale-down (90s)..."
for _ in $(seq 1 9); do
  PODS=$(kubectl -n "$NS" get pods -l app=worker --no-headers 2>/dev/null | wc -l)
  echo "  worker pods: $PODS"
  sleep 10
done

echo "DONE"
