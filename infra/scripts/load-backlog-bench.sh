#!/usr/bin/env bash
# load-backlog-bench.sh — sustained-backlog benchmark: queue N jobs at once and sample the fleet until it drains.
# Unlike load-queue-test.sh (scale-up mechanics, N=6), this measures throughput and per-container CPU
# while a backlog persists. Needs worker image with container-CPU metrics (worker_container_cpu_*).
# Usage: API_KEY=... ./load-backlog-bench.sh [N_JOBS=30] [VUS=10] [DURATION=30s]
set -euo pipefail
NS=${NAMESPACE:-loadtest-system}
N=${1:-30} VUS=${2:-10} DUR=${3:-30s} TIMEOUT=${TIMEOUT:-900} INTERVAL=${INTERVAL:-5}
. "$(dirname "$0")/lib-push-jobs.sh"

echo "==> baseline: waiting for queue empty"
until [[ "$(kubectl -n "$NS" exec deploy/redis -- sh -c 'redis-cli LLEN jobs:pending; redis-cli LLEN jobs:processing' | tr '\n' ' ')" == "0 0 " ]]; do sleep 2; done
echo "==> pushing $N jobs (VUS=$VUS duration=$DUR)"
push_jobs "$N" "$VUS" "$DUR"

# per worker pod: cores_used, limit, throttled_s, busy (via the pod's own /metrics)
scrape() {
  for p in $(kubectl -n "$NS" get pods -l app=worker --field-selector=status.phase=Running -o name 2>/dev/null); do
    kubectl -n "$NS" exec "$p" -- wget -qO- http://localhost:9464/metrics 2>/dev/null | awk '
      /^worker_container_cpu_cores_used /{u=$2} /^worker_container_cpu_limit_cores /{l=$2}
      /^worker_container_cpu_throttled_seconds_total /{t=$2} /^worker_current_job /{b=$2}
      /^worker_cpu_source\{source="[a-z0-9-]+"\} 1/{match($0,/"[^"]+"/); s=substr($0,RSTART+1,RLENGTH-2)}
      END{print u+0, l+0, t+0, b+0, s}' || true
  done
}

printf "%6s %5s %8s %10s %5s %9s %9s %10s %s\n" t_s ready pending processing busy fleet_cpu cpu/busy throttled_s source
t_drain="" PEAK_READY=0 PEAK_PEND=0 PEAK_CPU=0 THR=0 BACKLOG_S="" SUMCPU=0 SUMBUSY=0 NS_SAMPLES=0 SRC=""
for _ in $(seq 1 $((TIMEOUT / INTERVAL))); do
  now=$(echo "$(date +%s.%N) - $T_FIRST_POST" | bc)
  read -r PEND PROC < <(kubectl -n "$NS" exec deploy/redis -- sh -c 'echo $(redis-cli LLEN jobs:pending) $(redis-cli LLEN jobs:processing)' 2>/dev/null) || true
  READY=$(kubectl -n "$NS" get deploy worker -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true); READY=${READY:-0}
  read -r CPU THRS BUSY SRC < <(scrape | awk '{c+=$1; t+=$3; b+=$4; s=$5} END{print c+0, t+0, b+0, s}') || true
  PER=$(awk -v c="${CPU:-0}" -v b="${BUSY:-0}" 'BEGIN{printf "%.2f", b? c/b : 0}')
  printf "%6.0f %5s %8s %10s %5s %9.2f %9s %10.1f %s\n" "$now" "$READY" "${PEND:-?}" "${PROC:-?}" "${BUSY:-0}" "${CPU:-0}" "$PER" "${THRS:-0}" "${SRC:-?}"
  (( READY > PEAK_READY )) && PEAK_READY=$READY
  (( ${PEND:-0} > PEAK_PEND )) && PEAK_PEND=${PEND:-0}
  PEAK_CPU=$(awk -v a="$PEAK_CPU" -v b="${CPU:-0}" 'BEGIN{print (b>a)?b:a}')
  THR=$(awk -v a="$THR" -v b="${THRS:-0}" 'BEGIN{print (b>a)?b:a}')
  if (( ${BUSY:-0} > 0 )); then SUMCPU=$(awk -v a="$SUMCPU" -v b="${CPU:-0}" 'BEGIN{print a+b}'); SUMBUSY=$((SUMBUSY + BUSY)); fi
  (( ${PEND:-0} > 0 )) && BACKLOG_S=$now
  if [[ "${PEND:-1}" == 0 && "${PROC:-1}" == 0 ]]; then t_drain=$now; break; fi
  sleep "$INTERVAL"
done

echo ""
echo "RESULT jobs:                $N x $DUR (VUS=$VUS)"
echo "RESULT peak Ready workers:  $PEAK_READY   peak pending: $PEAK_PEND   backlog lasted: ${BACKLOG_S:-0}s"
echo "RESULT peak fleet CPU:      $PEAK_CPU cores (container cgroup, k6 included; source=$SRC)"
echo "RESULT CPU per busy worker: $(awk -v c="$SUMCPU" -v b="$SUMBUSY" 'BEGIN{printf "%.2f cores", b? c/b : 0}')"
echo "RESULT peak throttled:      ${THR}s (summed over live pods)"
if [[ -n "$t_drain" ]]; then
  echo "RESULT drain time:          ${t_drain}s   throughput: $(awk -v n="$N" -v t="$t_drain" 'BEGIN{printf "%.1f jobs/min", n*60/t}')"
else
  echo "RESULT drain time:          NOT DRAINED in ${TIMEOUT}s"
fi
