#!/usr/bin/env bash
# Publish docs/benchmarks/results/*.json to the cluster as ConfigMap chaos-results (read by the dashboard's Chaos tab).
# Re-run after new chaos runs; the kubelet refreshes the mounted files within ~1 min, no restart needed.
# ConfigMap limit is 1 MiB; the .log files are skipped (35 result files are ~140 KiB).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
OC=${OC:-oc}

ARGS=(); for f in "$ROOT"/docs/benchmarks/results/*.json; do ARGS+=(--from-file="$f"); done
(( ${#ARGS[@]} )) || { echo "no result files in docs/benchmarks/results" >&2; exit 1; }
$OC -n "$NAMESPACE" create configmap chaos-results "${ARGS[@]}" --dry-run=client -o yaml | $OC -n "$NAMESPACE" apply -f - >/dev/null
echo "configmap chaos-results applied in $NAMESPACE (${#ARGS[@]} files)"
