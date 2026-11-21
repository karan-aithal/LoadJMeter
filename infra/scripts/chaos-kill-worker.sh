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

CHAOS_KIND=chaos-run KILL_AFTER=${KILL_AFTER:-3}
. "$(dirname "$0")/lib-chaos.sh"

chaos_preflight
ENV_JSON=$(chaos_env_json)
chaos_submit
chaos_wait_running
KILLED=$OWNER
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
