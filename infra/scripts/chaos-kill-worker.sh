#!/usr/bin/env bash
# chaos-kill-worker.sh — one fault-injection run: hard-kill the exact worker pod running a job, then
# prove the SAME job is requeued, retried on another pod and completes exactly once.
#
#   submit long job -> wait running + worker_id -> match pod -> confirm in jobs:processing
#   -> force-delete that pod (T_KILL) -> poll retry (running on a different worker) -> poll completion
#
# Writes a JSON result (stdout + $OUT) and a sibling .log (reaper/worker logs, events). Exit 0 = PASS.
# Timings are client-side polls (0.5 s resolution) measured from just BEFORE the delete call (conservative).
# Usage: [DURATION=45s VUS=2 KILL_AFTER=3 OUT=file.json] ./infra/scripts/chaos-kill-worker.sh
# Requires: kubectl (or oc shim) on loadtest-system, API_KEY in env or ./.env, jq, curl, awk.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }
: "${API_KEY:?API_KEY not set}"
NS=${NAMESPACE:-loadtest-system}
DURATION=${DURATION:-45s} VUS=${VUS:-2} KILL_AFTER=${KILL_AFTER:-3}
RETRY_TIMEOUT=${RETRY_TIMEOUT:-120} DONE_TIMEOUT=${DONE_TIMEOUT:-300}
OUT=${OUT:-$ROOT/docs/benchmarks/results/chaos-run-$(date +%Y%m%d-%H%M%S).json}
LOG=${OUT%.json}.log
mkdir -p "$(dirname "$OUT")"

k()    { kubectl -n "$NS" "$@"; }
rcli() { k exec deploy/redis -- redis-cli "$@"; }
el()   { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", a-b}'; }   # bc drops the leading 0 -> invalid JSON
die()  { echo "ABORT: $*" >&2; exit 2; }

HOST=${API_HOST:-$(k get route control-api -o jsonpath='{.spec.host}')}
URL=https://$HOST
api() { curl -fsSk "$URL$2" -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"}; }

echo "==> Preconditions"
[[ $(k logs deploy/control-api --tail=-1 2>/dev/null | grep -c 'Reaper started') -ge 1 ]] || die "control-api is not running the reaper (rebuild/rollout it)"
[[ $(rcli llen jobs:pending) == 0 && $(rcli llen jobs:processing) == 0 ]] || die "queues not empty; drain first so the run is isolated"
(( $(k get pods -l app=worker --field-selector=status.phase=Running --no-headers | wc -l) >= 1 )) || die "no running worker"
TOKEN=$(curl -fsSk "$URL/auth/token" -H 'content-type: application/json' -d "{\"apiKey\":\"$API_KEY\"}" | jq -r .token)

ENV_JSON=$(jq -n \
  --arg sha "$(git -C "$ROOT" rev-parse HEAD)" --arg dirty "$(git -C "$ROOT" status --porcelain | wc -l)" \
  --arg wimg "$(k get pods -l app=worker -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')" \
  --arg cimg "$(k get pods -l app=control-api -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')" \
  --argjson wres "$(k get deploy worker -o json | jq -c '.spec.template.spec.containers[0].resources')" \
  --argjson wrep "$(k get deploy worker -o jsonpath='{.spec.replicas}')" \
  --arg reaper "$(k exec deploy/control-api -- env | grep -E '^(REAPER_|MAX_RETRIES|HEARTBEAT)' | jq -R -s -c 'split("\n")|map(select(length>0)|split("=")|{(.[0]):.[1]})|add')" \
  '{git_sha:$sha, uncommitted_files:($dirty|tonumber), worker_image:$wimg, control_api_image:$cimg,
    worker_resources:$wres, worker_replicas:$wrep, reaper_env:($reaper|fromjson)}')

echo "==> Submit job (VUS=$VUS duration=$DURATION)"
ID=$(curl -fsSk "$URL/tests" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: chaos-$(date +%s)-$$" -d "{\"scenario\":\"fast\",\"vus\":$VUS,\"duration\":\"$DURATION\"}" | jq -r .id)
[[ -n $ID && $ID != null ]] || die "job submit failed"
T_SUBMIT=$(date +%s.%N); echo "  job $ID"

echo "==> Wait for running + worker_id"
KILLED=""
while :; do
  read -r st wid < <(api GET "/tests/$ID" | jq -r '[.status,(.worker_id//"")]|@tsv') || true
  [[ ${st:-} == running && -n ${wid:-} ]] && { KILLED=$wid; break; }
  (( $(date +%s) - ${T_SUBMIT%.*} > 90 )) && die "job never reached running (status=${st:-?})"
  sleep 0.5
done
echo "  running on worker_id=$KILLED"

echo "==> Match worker_id to pod, confirm payload in jobs:processing"
k get pod "$KILLED" -o name >/dev/null 2>&1 || die "no pod named $KILLED (WORKER_ID is not the hostname?)"
rcli lrange jobs:processing 0 -1 | grep -qF "\"id\":\"$ID\"" || die "job $ID not in jobs:processing"
sleep "$KILL_AFTER"

echo "==> Force-delete $KILLED"
T_KILL=$(date +%s.%N)
k delete pod "$KILLED" --grace-period=0 --force >/dev/null 2>&1

echo "==> Poll retry + completion"
T_REQ="" T_RETRY="" T_DONE="" RETRY_WORKER="" REASON=""
while :; do
  now=$(date +%s.%N)
  if J=$(api GET "/tests/$ID" 2>/dev/null); then
    read -r st wid < <(jq -r '[.status,(.worker_id//"")]|@tsv' <<<"$J") || true
    [[ -z $T_REQ && $st == pending ]] && T_REQ=$now
    [[ -z $T_RETRY && $st == running && $wid != "$KILLED" ]] && { T_RETRY=$now; RETRY_WORKER=$wid; echo "  retry running on $wid (+$(el "$now" "$T_KILL")s)"; }
    case $st in completed|failed|cancelled) T_DONE=$now; FINAL=$J; break;; esac
  fi
  [[ -z $T_RETRY ]] && (( $(awk -v a="$now" -v b="$T_KILL" 'BEGIN{print (a-b>'"$RETRY_TIMEOUT"')}') )) && { REASON="no retry within ${RETRY_TIMEOUT}s"; break; }
  (( $(awk -v a="$now" -v b="$T_KILL" 'BEGIN{print (a-b>'"$DONE_TIMEOUT"')}') )) && { REASON="not terminal within ${DONE_TIMEOUT}s"; break; }
  sleep 0.5
done
[[ -n ${FINAL:-} ]] || FINAL=$(api GET "/tests/$ID")

echo "==> Evidence"
WLOGS=$(k logs -l app=worker --tail=-1 --prefix 2>/dev/null || true)
CLOGS=$(k logs deploy/control-api --tail=-1 2>/dev/null || true)
jl() { sed -E 's/^\[[^]]*\] //' | jq -R -c --arg id "$ID" 'fromjson? | select(.jobId==$id)'; }
COMPLETIONS=$(jl <<<"$WLOGS" | jq -s '[.[]|select(.msg=="job completed")]|length')
PICKS=$(jl <<<"$WLOGS" | jq -s '[.[]|select(.msg=="job picked")]|length')
RETRY_ATTEMPT=$(jl <<<"$WLOGS" | jq -s '[.[]|select(.msg=="job picked")|.attempt]|max // null')
REAPED=$(jl <<<"$CLOGS" | jq -s '[.[]|select(.msg=="job_reaped")]|length')
IN_DLQ=$(rcli lrange jobs:dead-letter 0 -1 | grep -cF "\"id\":\"$ID\"" || true)
STUCK=$({ rcli lrange jobs:processing 0 -1; rcli lrange jobs:pending 0 -1; } | grep -cF "\"id\":\"$ID\"" || true)
{ echo "## control-api job_reaped"; jl <<<"$CLOGS"; echo "## worker lines for job"; jl <<<"$WLOGS"
  echo "## events"; k get events --sort-by=.lastTimestamp | tail -25; } >"$LOG" 2>&1 || true

FINAL_STATUS=$(jq -r .status <<<"$FINAL"); VERDICT=$(jq -r '.verdict // ""' <<<"$FINAL")
PASS=false
[[ $FINAL_STATUS == completed && -n $T_RETRY && $COMPLETIONS == 1 && $REAPED == 1 && $IN_DLQ == 0 && $STUCK == 0 ]] && PASS=true
n() { [[ -n $1 ]] && el "$1" "$T_KILL" || echo null; }

jq -n --arg id "$ID" --arg killed "$KILLED" --arg retryw "$RETRY_WORKER" --arg fs "$FINAL_STATUS" --arg v "$VERDICT" \
  --arg reason "$REASON" --argjson pass "$PASS" --argjson env "$ENV_JSON" \
  --argjson requeue "$(n "$T_REQ")" --argjson mttr "$(n "$T_RETRY")" --argjson done "$(n "$T_DONE")" \
  --argjson comp "$COMPLETIONS" --argjson picks "$PICKS" --argjson reaped "$REAPED" --argjson dlq "$IN_DLQ" \
  --argjson stuck "$STUCK" --argjson attempt "${RETRY_ATTEMPT:-null}" --arg dur "$DURATION" --argjson vus "$VUS" \
  '{result:(if $pass then "PASS" else "FAIL" end), fail_reason:$reason, job_id:$id, killed_worker:$killed,
    retry_worker:$retryw, final_status:$fs, verdict:$v,
    mttr_seconds:$mttr, requeue_seen_seconds:$requeue, completion_seconds:$done,
    retry_attempt_seen_by_worker:$attempt, successful_completions:$comp, executions_started_on_surviving_pods:$picks,
    reaper_events:$reaped, in_dead_letter:($dlq>0), left_in_redis:($stuck>0),
    duplicate_completions:(if $comp>1 then $comp-1 else 0 end),
    job:{duration:$dur, vus:$vus}, env:$env}' | tee "$OUT"
echo "log: $LOG" >&2
[[ $PASS == true ]]
