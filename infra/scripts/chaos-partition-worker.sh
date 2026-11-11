#!/usr/bin/env bash
# chaos-partition-worker.sh — one network-partition run. The worker pod is NOT killed: it keeps running k6 but
# loses its path to control-api, so its heartbeats stop. Proves the stale worker is fenced out after the heal:
#
#   submit job -> wait running on pod P -> isolate P from control-api (egress NetworkPolicy; P also leaves the
#   worker ReplicaSet so the Deployment starts a replacement) -> reaper requeues -> replacement starts the retry
#   -> heal P while its k6 is still running -> P's next heartbeat must be fenced (409) and P must stop
#   -> the job completes exactly once, on the replacement, never on P.
#
# Result JSON (stdout + $OUT) and a sibling .log. Exit 0 = PASS. Timings are client-side polls from the moment
# the partition is confirmed (a request from P to control-api fails).
# Usage: [DURATION=75s HEAL_AFTER=5 OUT=file.json] ./infra/scripts/chaos-partition-worker.sh
set -euo pipefail

CHAOS_KIND=partition-run DURATION=${DURATION:-75s}
. "$(dirname "$0")/lib-chaos.sh"
HEAL_AFTER=${HEAL_AFTER:-5}      # seconds after the retry starts on the replacement
FENCE_TIMEOUT=${FENCE_TIMEOUT:-60}
POLICY=chaos-partition

chaos_preflight
ENV_JSON=$(chaos_env_json)
chaos_submit
chaos_wait_running
PART=$OWNER

cleanup() {
  k delete networkpolicy "$POLICY" --ignore-not-found >/dev/null 2>&1 || true
  k delete pod "$PART" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true   # orphan: would pop jobs
}
trap cleanup EXIT

reachable() {   # can pod $1 reach control-api? prints OK or ERR
  k exec "$1" -- node -e "const r=require('http').get('http://control-api:4000/healthz',x=>{console.log('OK');process.exit(0)});r.on('error',()=>{console.log('ERR');process.exit(0)});r.setTimeout(3000,()=>{console.log('ERR');process.exit(0)})" 2>/dev/null || echo ERR
}

echo "==> Partition $PART from control-api"
k apply -f - >/dev/null <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: $POLICY }
spec:
  podSelector: { matchLabels: { chaos: partition } }
  policyTypes: [Egress]
  egress:   # worker-egress minus control-api: DNS, redis, sut only
    - to: [ { namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: openshift-dns } } } ]
      ports: [ { port: 5353, protocol: UDP }, { port: 5353, protocol: TCP }, { port: 53, protocol: UDP }, { port: 53, protocol: TCP } ]
    - to: [ { podSelector: { matchLabels: { app: redis } } } ]
      ports: [ { port: 6379, protocol: TCP } ]
    - to: [ { podSelector: { matchLabels: { app: sut } } } ]
      ports: [ { port: 3000, protocol: TCP } ]
YAML
# 'app' leaves the pod so worker-egress (which allows control-api) stops selecting it and the ReplicaSet
# no longer owns it (a replacement starts); 'chaos' makes it match the restrictive policy above.
k label pod "$PART" chaos=partition app- --overwrite >/dev/null
T_PART=$(date +%s.%N)
for _ in $(seq 40); do [[ $(reachable "$PART") == ERR ]] && break; sleep 0.5; done
[[ $(reachable "$PART") == ERR ]] || die "partition did not take effect (pod still reaches control-api)"
T_PART=$(date +%s.%N)
echo "  partition confirmed"

echo "==> Poll retry on a different worker"
T_RETRY="" T_HEAL="" T_DONE="" RETRY_WORKER="" REASON="" FINAL=""
while :; do
  now=$(date +%s.%N)
  if J=$(api GET "/tests/$ID" 2>/dev/null); then
    read -r st wid < <(jq -r '[.status,(.worker_id//"")]|@tsv' <<<"$J") || true
    if [[ -z $T_RETRY && $st == running && $wid != "$PART" ]]; then
      T_RETRY=$now; RETRY_WORKER=$wid; echo "  retry running on $wid (+$(el "$now" "$T_PART")s)"
    fi
    if [[ -n $T_RETRY && -z $T_HEAL && $(gt "$(el "$now" "$T_RETRY")" "$HEAL_AFTER") == 1 ]]; then
      k delete networkpolicy "$POLICY" >/dev/null; T_HEAL=$(date +%s.%N); echo "  healed (+$(el "$T_HEAL" "$T_PART")s)"
    fi
    case $st in completed|failed|cancelled) T_DONE=$now; FINAL=$J; break;; esac
  fi
  [[ -z $T_RETRY ]] && (( $(gt "$(el "$now" "$T_PART")" "$RETRY_TIMEOUT") )) && { REASON="no retry within ${RETRY_TIMEOUT}s"; break; }
  (( $(gt "$(el "$now" "$T_PART")" "$DONE_TIMEOUT") )) && { REASON="not terminal within ${DONE_TIMEOUT}s"; break; }
  sleep 0.5
done
[[ -n $FINAL ]] || FINAL=$(api GET "/tests/$ID")
[[ -n $T_HEAL ]] || { k delete networkpolicy "$POLICY" --ignore-not-found >/dev/null; T_HEAL=$(date +%s.%N); }

# The stale worker must notice it was fenced (heartbeat 409) and stop. Give it time to heartbeat after the heal.
echo "==> Wait for the stale worker to be fenced"
T_FENCED=""
for _ in $(seq $((FENCE_TIMEOUT * 2))); do
  if k logs "$PART" --tail=-1 2>/dev/null | grep -q -E 'heartbeat fenced|status update fenced|ownership lost'; then T_FENCED=$(date +%s.%N); break; fi
  sleep 0.5
done

echo "==> Evidence"
PLOGS=$(k logs "$PART" --tail=-1 2>/dev/null || true)
WLOGS=$(k logs -l app=worker --tail=-1 --prefix 2>/dev/null || true)
CLOGS=$(k logs deploy/control-api --tail=-1 2>/dev/null || true)
count() { jl <<<"$1" | jq -s --arg m "$2" '[.[]|select(.msg==$m)]|length'; }
STALE_COMPLETIONS=$(count "$PLOGS" "job completed")
COMPLETIONS=$(( $(count "$WLOGS" "job completed") + STALE_COMPLETIONS ))
STALE_OWNERSHIP_LOST=$(jl <<<"$PLOGS" | jq -s '[.[]|select(.msg=="ownership lost, result discarded" or .msg=="heartbeat fenced" or .msg=="status update fenced")]|length')
REAPED=$(count "$CLOGS" "job_reaped")
FENCED_WRITES=$(count "$CLOGS" "fenced_write")
IN_DLQ=$(rcli lrange jobs:dead-letter 0 -1 | grep -cF "\"id\":\"$ID\"" || true)
STUCK=$({ rcli lrange jobs:processing 0 -1; rcli lrange jobs:pending 0 -1; } | grep -cF "\"id\":\"$ID\"" || true)
FINAL_STATUS=$(jq -r .status <<<"$FINAL"); VERDICT=$(jq -r '.verdict // ""' <<<"$FINAL"); FINAL_WORKER=$(jq -r '.worker_id // ""' <<<"$FINAL")
{ echo "## stale worker $PART"; jl <<<"$PLOGS"; echo "## control-api reaper/fencing"; jl <<<"$CLOGS" | jq -c 'select(.msg=="job_reaped" or .msg=="fenced_write")'
  echo "## worker lines"; jl <<<"$WLOGS"; echo "## events"; k get events --sort-by=.lastTimestamp | tail -25; } >"$LOG" 2>&1 || true

PASS=false
[[ $FINAL_STATUS == completed && $FINAL_WORKER == "$RETRY_WORKER" && $FINAL_WORKER != "$PART" && $COMPLETIONS == 1 \
   && $STALE_COMPLETIONS == 0 && $REAPED == 1 && $FENCED_WRITES -ge 1 && $STALE_OWNERSHIP_LOST -ge 1 \
   && $IN_DLQ == 0 && $STUCK == 0 ]] && PASS=true
n() { [[ -n $1 ]] && el "$1" "$T_PART" || echo null; }

jq -n --arg id "$ID" --arg part "$PART" --arg retryw "$RETRY_WORKER" --arg finalw "$FINAL_WORKER" --arg fs "$FINAL_STATUS" \
  --arg v "$VERDICT" --arg reason "$REASON" --argjson pass "$PASS" --argjson env "$ENV_JSON" \
  --argjson retry "$(n "$T_RETRY")" --argjson heal "$(n "$T_HEAL")" --argjson fenced "$(n "$T_FENCED")" --argjson done "$(n "$T_DONE")" \
  --argjson comp "$COMPLETIONS" --argjson stalec "$STALE_COMPLETIONS" --argjson lost "$STALE_OWNERSHIP_LOST" \
  --argjson reaped "$REAPED" --argjson fw "$FENCED_WRITES" --argjson dlq "$IN_DLQ" --argjson stuck "$STUCK" \
  --arg dur "$DURATION" --argjson vus "$VUS" --argjson ha "$HEAL_AFTER" \
  '{result:(if $pass then "PASS" else "FAIL" end), fail_reason:$reason, job_id:$id, partitioned_worker:$part,
    retry_worker:$retryw, final_worker:$finalw, final_status:$fs, verdict:$v,
    mttr_seconds:$retry, heal_seconds:$heal, stale_worker_fenced_seconds:$fenced, completion_seconds:$done,
    successful_completions:$comp, stale_worker_completions:$stalec, stale_worker_fence_events:$lost,
    control_api_fenced_writes:$fw, reaper_events:$reaped, in_dead_letter:($dlq>0), left_in_redis:($stuck>0),
    duplicate_completions:(if $comp>1 then $comp-1 else 0 end),
    job:{duration:$dur, vus:$vus, heal_after_retry_start:$ha}, env:$env}' | tee "$OUT"
echo "log: $LOG" >&2
[[ $PASS == true ]]
