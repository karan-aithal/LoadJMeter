#!/usr/bin/env bash
# End-to-end smoke: token -> POST /tests -> poll until terminal. Uses the control-api Route.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }
OC=${OC:-oc}; : "${API_KEY:?}"
HOST=$($OC -n "$NAMESPACE" get route control-api -o jsonpath='{.spec.host}')
URL=https://$HOST; CURL="curl -fsSk"   # -k: CRC router uses a self-signed cert
TOKEN=$($CURL "$URL/auth/token" -H 'content-type: application/json' -d "{\"apiKey\":\"$API_KEY\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
ID=$($CURL "$URL/tests" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: smoke-$(date +%s)" -d "{\"scenario\":\"fast\",\"vus\":2,\"duration\":\"${DURATION:-20s}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "run $ID"
for _ in $(seq 1 60); do
  S=$($CURL "$URL/tests/$ID" -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],d.get("verdict") or "")')
  echo "  $S"; case $S in completed*) echo SMOKE PASS; exit 0;; failed*|cancelled*) echo SMOKE FAIL; exit 1;; esac
  sleep 3
done
echo "SMOKE TIMEOUT"; exit 1
