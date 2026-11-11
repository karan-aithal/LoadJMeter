# Sourced by chaos-*.sh. Needs: kubectl (or oc shim), jq, curl, awk; API_KEY in env or ./.env.
# Provides: k rcli el die api jl, chaos_preflight, chaos_env_json, chaos_submit, chaos_wait_running.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }
: "${API_KEY:?API_KEY not set}"
NS=${NAMESPACE:-loadtest-system}
DURATION=${DURATION:-45s} VUS=${VUS:-2}
RETRY_TIMEOUT=${RETRY_TIMEOUT:-120} DONE_TIMEOUT=${DONE_TIMEOUT:-300}
OUT=${OUT:-$ROOT/docs/benchmarks/results/${CHAOS_KIND:-chaos}-$(date +%Y%m%d-%H%M%S).json}
LOG=${OUT%.json}.log
mkdir -p "$(dirname "$OUT")"

k()    { kubectl -n "$NS" "$@"; }
rcli() { k exec deploy/redis -- redis-cli "$@"; }
el()   { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", a-b}'; }   # bc drops the leading 0 -> invalid JSON
die()  { echo "ABORT: $*" >&2; exit 2; }
gt()   { awk -v a="$1" -v b="$2" 'BEGIN{print (a>b)?1:0}'; }       # float a > b

HOST=${API_HOST:-$(k get route control-api -o jsonpath='{.spec.host}')}
URL=https://$HOST
api() { curl -fsSk "$URL$2" -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"}; }
# log lines (JSON) of one job; strips the "[pod/x/y] " prefix added by kubectl logs --prefix
jl()  { sed -E 's/^\[[^]]*\] //' | jq -R -c --arg id "$ID" 'fromjson? | select(.jobId==$id)'; }

chaos_preflight() {
  echo "==> Preconditions"
  [[ $(k logs deploy/control-api --tail=-1 2>/dev/null | grep -c 'Reaper started') -ge 1 ]] || die "control-api is not running the reaper (rebuild/rollout it)"
  [[ $(rcli llen jobs:pending) == 0 && $(rcli llen jobs:processing) == 0 ]] || die "queues not empty; drain first so the run is isolated"
  (( $(k get pods -l app=worker --field-selector=status.phase=Running --no-headers | wc -l) >= 1 )) || die "no running worker"
  TOKEN=$(curl -fsSk "$URL/auth/token" -H 'content-type: application/json' -d "{\"apiKey\":\"$API_KEY\"}" | jq -r .token)
}

chaos_env_json() {
  jq -n \
    --arg sha "$(git -C "$ROOT" rev-parse HEAD)" --arg dirty "$(git -C "$ROOT" status --porcelain | wc -l)" \
    --arg wimg "$(k get pods -l app=worker -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')" \
    --arg cimg "$(k get pods -l app=control-api -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')" \
    --argjson wres "$(k get deploy worker -o json | jq -c '.spec.template.spec.containers[0].resources')" \
    --argjson wrep "$(k get deploy worker -o jsonpath='{.spec.replicas}')" \
    --arg reaper "$(k exec deploy/control-api -- env | grep -E '^(REAPER_|MAX_RETRIES|HEARTBEAT)' | jq -R -s -c 'split("\n")|map(select(length>0)|split("=")|{(.[0]):.[1]})|add')" \
    '{git_sha:$sha, uncommitted_files:($dirty|tonumber), worker_image:$wimg, control_api_image:$cimg,
      worker_resources:$wres, worker_replicas:$wrep, reaper_env:($reaper|fromjson)}'
}

chaos_submit() {   # sets ID, T_SUBMIT
  echo "==> Submit job (VUS=$VUS duration=$DURATION)"
  ID=$(curl -fsSk "$URL/tests" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H "Idempotency-Key: chaos-$(date +%s)-$$" -d "{\"scenario\":\"fast\",\"vus\":$VUS,\"duration\":\"$DURATION\"}" | jq -r .id)
  [[ -n $ID && $ID != null ]] || die "job submit failed"
  T_SUBMIT=$(date +%s.%N); echo "  job $ID"
}

chaos_wait_running() {   # sets OWNER = worker_id of the pod running the job; checks pod match + jobs:processing
  echo "==> Wait for running + worker_id"
  OWNER=""
  while :; do
    read -r st wid < <(api GET "/tests/$ID" | jq -r '[.status,(.worker_id//"")]|@tsv') || true
    [[ ${st:-} == running && -n ${wid:-} ]] && { OWNER=$wid; break; }
    (( $(date +%s) - ${T_SUBMIT%.*} > 90 )) && die "job never reached running (status=${st:-?})"
    sleep 0.5
  done
  echo "  running on worker_id=$OWNER"
  echo "==> Match worker_id to pod, confirm payload in jobs:processing"
  k get pod "$OWNER" -o name >/dev/null 2>&1 || die "no pod named $OWNER (WORKER_ID is not the hostname?)"
  rcli lrange jobs:processing 0 -1 | grep -qF "\"id\":\"$ID\"" || die "job $ID not in jobs:processing"
}
