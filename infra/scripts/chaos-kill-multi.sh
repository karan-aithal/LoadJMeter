#!/usr/bin/env bash
# chaos-kill-multi.sh — fault injection under a realistic mix: several workers run different jobs at once, one
# specific worker is hard-killed, and EVERY job must still finish exactly once (the victim's after a retry, the
# others undisturbed). Complements chaos-kill-worker.sh (one job, one worker).
#
# Usage: [WORKERS=3 JOBS="fast:2:45s slow:5:60s cpu-heavy:10:45s" VICTIM=1 CPU_REQUEST=250m KILL_AFTER=3 OUT=f.json] \
#          ./infra/scripts/chaos-kill-multi.sh
#   JOBS     space-separated scenario:vus:duration, one per worker (WORKERS must be >= number of jobs)
#   VICTIM   1-based index of the job whose worker is killed
#   CPU_REQUEST  optional worker CPU request (e.g. 500m); the original is restored on exit
# KEDA owns the worker replica count, so it is paused at WORKERS for the run (annotation removed on exit).
set -euo pipefail

CHAOS_KIND=${CHAOS_KIND:-chaos-multi-run}
. "$(dirname "$0")/lib-chaos.sh"
WORKERS=${WORKERS:-3} JOBS=${JOBS:-"fast:2:45s slow:5:60s cpu-heavy:10:45s"} VICTIM=${VICTIM:-1}
KILL_AFTER=${KILL_AFTER:-3} CPU_REQUEST=${CPU_REQUEST:-}
read -ra SPECS <<<"$JOBS"
NJ=${#SPECS[@]}
(( NJ >= 1 && NJ <= WORKERS )) || die "need 1..WORKERS jobs"
(( VICTIM >= 1 && VICTIM <= NJ )) || die "VICTIM out of range"

SO=worker-scaledobject
ORIG_CPU=$(k get deploy worker -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}')
cleanup() {
  k annotate scaledobject "$SO" autoscaling.keda.sh/paused-replicas- >/dev/null 2>&1 || true
  if [[ -n $CPU_REQUEST && $CPU_REQUEST != "$ORIG_CPU" ]]; then
    k set resources deploy/worker --requests=cpu="$ORIG_CPU" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ready_workers() { k get deploy worker -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true; }

echo "==> Capacity: $WORKERS workers${CPU_REQUEST:+ @ cpu request $CPU_REQUEST}"
if [[ -n $CPU_REQUEST && $CPU_REQUEST != "$ORIG_CPU" ]]; then
  # Shrink to one worker first: a previous run's extra pods still hold CPU on this node (3.8 CPU) and would leave the
  # re-sized pods Pending (Insufficient cpu). Pausing KEDA at 1 scales down immediately instead of after its cooldown.
  k annotate scaledobject "$SO" autoscaling.keda.sh/paused-replicas=1 --overwrite >/dev/null
  for _ in $(seq 90); do [[ $(k get deploy worker -o jsonpath='{.status.replicas}') == 1 ]] && break; sleep 2; done
  k set resources deploy/worker --requests=cpu="$CPU_REQUEST" >/dev/null
  k rollout status deploy/worker --timeout=180s >/dev/null
fi
k annotate scaledobject "$SO" autoscaling.keda.sh/paused-replicas="$WORKERS" --overwrite >/dev/null
for _ in $(seq 120); do [[ $(ready_workers) == "$WORKERS" ]] && break; sleep 2; done
[[ $(ready_workers) == "$WORKERS" ]] || die "only $(ready_workers) of $WORKERS workers became Ready (node CPU?)"
# pods from a previous scale-down may still be terminating; require exactly WORKERS running pods
(( $(k get pods -l app=worker --field-selector=status.phase=Running --no-headers | grep -vc Terminating) == WORKERS )) || sleep 10

chaos_preflight
ENV_JSON=$(chaos_env_json)

echo "==> Submit ${NJ} jobs"
IDS=() OWNERS=() SC=() VU=() DUR=()
T_SUBMIT=$(date +%s.%N)
for i in "${!SPECS[@]}"; do
  IFS=: read -r sc vus dur <<<"${SPECS[$i]}"
  id=$(curl -fsSk "$URL/tests" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H "Idempotency-Key: chaos-multi-$(date +%s)-$$-$i" -d "{\"scenario\":\"$sc\",\"vus\":$vus,\"duration\":\"$dur\"}" | jq -r .id)
  [[ -n $id && $id != null ]] || die "submit failed"
  IDS+=("$id") SC+=("$sc") VU+=("$vus") DUR+=("$dur"); echo "  job $((i+1)): $sc vus=$vus $dur -> $id"
done

echo "==> Wait for all jobs running on distinct workers"
while :; do
  ok=0; OWNERS=()
  for i in "${!IDS[@]}"; do
    read -r st wid < <(api GET "/tests/${IDS[$i]}" | jq -r '[.status,(.worker_id//"")]|@tsv') || true
    if [[ ${st:-} == running && -n ${wid:-} ]]; then OWNERS+=("$wid"); ok=$((ok+1)); else OWNERS+=(""); fi
  done
  (( ok == NJ )) && break
  (( $(date +%s) - ${T_SUBMIT%.*} > 120 )) && die "jobs never all reached running ($ok/$NJ)"
  sleep 1
done
[[ $(printf '%s\n' "${OWNERS[@]}" | sort -u | wc -l) == "$NJ" ]] || die "jobs share a worker"
V=$((VICTIM-1)); KILLED=${OWNERS[$V]}; VID=${IDS[$V]}
k get pod "$KILLED" -o name >/dev/null 2>&1 || die "no pod $KILLED"
echo "  victim: job $VICTIM (${SC[$V]}) on $KILLED"
sleep "$KILL_AFTER"

echo "==> Force-delete $KILLED"
T_KILL=$(date +%s.%N)
k delete pod "$KILLED" --grace-period=0 --force >/dev/null 2>&1

echo "==> Poll all jobs to completion"
declare -A T_DONE FINAL_J
T_RETRY="" RETRY_WORKER="" REASON=""
while :; do
  now=$(date +%s.%N); pending=0
  for i in "${!IDS[@]}"; do
    id=${IDS[$i]}
    [[ -n ${T_DONE[$id]:-} ]] && continue
    J=$(api GET "/tests/$id" 2>/dev/null) || { pending=$((pending+1)); continue; }
    read -r st wid < <(jq -r '[.status,(.worker_id//"")]|@tsv' <<<"$J") || true
    if [[ $i == "$V" && -z $T_RETRY && $st == running && $wid != "$KILLED" ]]; then
      T_RETRY=$now; RETRY_WORKER=$wid; echo "  victim retry running on $wid (+$(el "$now" "$T_KILL")s)"
    fi
    case $st in completed|failed|cancelled) T_DONE[$id]=$now; FINAL_J[$id]=$J;; *) pending=$((pending+1));; esac
  done
  (( pending == 0 )) && break
  [[ -z $T_RETRY ]] && (( $(gt "$(el "$now" "$T_KILL")" "$RETRY_TIMEOUT") )) && { REASON="no retry within ${RETRY_TIMEOUT}s"; break; }
  (( $(gt "$(el "$now" "$T_KILL")" "$DONE_TIMEOUT") )) && { REASON="not all terminal within ${DONE_TIMEOUT}s"; break; }
  sleep 0.5
done

echo "==> Evidence"
WLOGS=$(k logs -l app=worker --tail=-1 --prefix 2>/dev/null || true)
CLOGS=$(k logs deploy/control-api --tail=-1 2>/dev/null || true)
DLQ=$(rcli lrange jobs:dead-letter 0 -1); LEFT=$({ rcli lrange jobs:processing 0 -1; rcli lrange jobs:pending 0 -1; })
JOBS_JSON="[]"; ALL_OK=1; DUPS=0; ANY_DLQ=0; ANY_LEFT=0; : >"$LOG"
for i in "${!IDS[@]}"; do
  ID=${IDS[$i]}
  comp=$(jl <<<"$WLOGS" | jq -s '[.[]|select(.msg=="job completed")]|length')
  reaped=$(jl <<<"$CLOGS" | jq -s '[.[]|select(.msg=="job_reaped")]|length')
  picks=$(jl <<<"$WLOGS" | jq -s '[.[]|select(.msg=="job picked")]|length')
  dlq=$(grep -cF "\"id\":\"$ID\"" <<<"$DLQ" || true); left=$(grep -cF "\"id\":\"$ID\"" <<<"$LEFT" || true)
  fj=${FINAL_J[$ID]:-$(api GET "/tests/$ID")}
  fs=$(jq -r .status <<<"$fj"); fw=$(jq -r '.worker_id // ""' <<<"$fj")
  want_reaped=0; [[ $i == "$V" ]] && want_reaped=1
  # non-victims must be undisturbed: finished on the worker they started on, picked once, never reaped
  good=1; [[ $fs == completed && $comp == 1 && $reaped == "$want_reaped" && $dlq == 0 && $left == 0 ]] || good=0
  if [[ $i != "$V" ]]; then [[ $fw == "${OWNERS[$i]}" && $picks == 1 ]] || good=0; fi
  (( good )) || ALL_OK=0
  (( comp > 1 )) && DUPS=$((DUPS + comp - 1)); (( dlq > 0 )) && ANY_DLQ=1; (( left > 0 )) && ANY_LEFT=1
  JOBS_JSON=$(jq -c --arg id "$ID" --arg sc "${SC[$i]}" --argjson vus "${VU[$i]}" --arg dur "${DUR[$i]}" --arg owner "${OWNERS[$i]}" \
    --arg fw "$fw" --arg fs "$fs" --argjson comp "$comp" --argjson reaped "$reaped" --argjson picks "$picks" --argjson victim "$([[ $i == "$V" ]] && echo true || echo false)" \
    --argjson ok "$good" --argjson done "$([[ -n ${T_DONE[$ID]:-} ]] && el "${T_DONE[$ID]}" "$T_KILL" || echo null)" \
    '. + [{job_id:$id, scenario:$sc, vus:$vus, duration:$dur, victim:$victim, started_on:$owner, finished_on:$fw, final_status:$fs,
          successful_completions:$comp, reaper_events:$reaped, executions_started:$picks, ok:($ok==1), completion_seconds_since_kill:$done}]' <<<"$JOBS_JSON")
  { echo "## job $((i+1)) $ID"; jl <<<"$WLOGS"; jl <<<"$CLOGS" | jq -c 'select(.msg=="job_reaped" or .msg=="fenced_write")'; } >>"$LOG" 2>&1
done
k get events --sort-by=.lastTimestamp 2>/dev/null | tail -25 >>"$LOG" || true

PASS=false; [[ $ALL_OK == 1 && -n $T_RETRY && -z $REASON ]] && PASS=true
VFS=$(jq -r --argjson v "$V" '.[$v].final_status' <<<"$JOBS_JSON")
n() { [[ -n $1 ]] && el "$1" "$T_KILL" || echo null; }
jq -n --argjson pass "$PASS" --arg reason "$REASON" --arg killed "$KILLED" --arg retryw "$RETRY_WORKER" --arg vid "$VID" --arg vfs "$VFS" \
  --argjson mttr "$(n "$T_RETRY")" --argjson done "$(n "${T_DONE[$VID]:-}")" --argjson jobs "$JOBS_JSON" --argjson dups "$DUPS" \
  --argjson dlq "$ANY_DLQ" --argjson left "$ANY_LEFT" --argjson workers "$WORKERS" --arg cpu "${CPU_REQUEST:-$ORIG_CPU}" --argjson env "$ENV_JSON" \
  --argjson nj "$NJ" \
  '{result:(if $pass then "PASS" else "FAIL" end), fail_reason:$reason, job_id:$vid, killed_worker:$killed, retry_worker:$retryw,
    final_status:(if ($jobs|all(.final_status=="completed")) then "completed" else $vfs end),
    mttr_seconds:$mttr, completion_seconds:$done, duplicate_completions:$dups, in_dead_letter:($dlq==1), left_in_redis:($left==1),
    config:{workers:$workers, concurrent_jobs:$nj, worker_cpu_request:$cpu}, jobs:$jobs, env:$env}' | tee "$OUT"
echo "log: $LOG" >&2
[[ $PASS == true ]]
