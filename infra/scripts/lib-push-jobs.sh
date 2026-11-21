# Sourced helper: push_jobs N VUS DURATION  (needs NS, API_KEY; optional SCENARIO=fast|slow|cpu-heavy|base; sets T_FIRST_POST epoch seconds)
push_jobs() {
  local n=$1 vus=$2 dur=$3 port=14000 prefix="load-test-$(date +%s)" token status i
  kubectl -n "$NS" port-forward svc/control-api "$port:4000" >/dev/null &
  local pf=$!
  sleep 2
  token=$(curl -sf -X POST "http://localhost:$port/auth/token" -H 'Content-Type: application/json' \
    -d "{\"apiKey\":\"$API_KEY\"}" | jq -r .token)
  if [[ -z "$token" || "$token" == "null" ]]; then
    echo "ERROR: failed to obtain JWT — is API_KEY set?" >&2; kill $pf 2>/dev/null || true; return 1
  fi
  T_FIRST_POST=$(date +%s.%N)
  for i in $(seq 1 "$n"); do
    status=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "http://localhost:$port/tests" \
      -H "Authorization: Bearer $token" -H "Idempotency-Key: ${prefix}-job-${i}" -H 'Content-Type: application/json' \
      -d "{\"scenario\":\"${SCENARIO:-fast}\",\"vus\":$vus,\"duration\":\"$dur\"}")
    echo "  job $i → HTTP $status"
  done
  kill $pf 2>/dev/null || true
}
