#!/usr/bin/env bash
# Build images inside the cluster into the OKD internal registry (binary Docker builds) and mirror redis.
# Usage: build-images.sh [service...]   (default: all)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
OC=${OC:-oc}; SERVICES=("$@"); (( ${#SERVICES[@]} )) || SERVICES=(sut control-api worker ui)

$OC -n "$NAMESPACE" apply -f "$HERE/../base/imagestreams.yaml" -f "$HERE/../base/buildconfigs.yaml"
# imagestreams.yaml makes the API import redis itself; wait for the tag instead of racing it with `oc import-image`
for _ in $(seq 60); do $OC -n "$NAMESPACE" get istag redis:7.2-alpine >/dev/null 2>&1 && break; sleep 2; done
$OC -n "$NAMESPACE" get istag redis:7.2-alpine >/dev/null || { echo "redis:7.2-alpine import did not finish (check docker.io access)" >&2; exit 1; }
for s in "${SERVICES[@]}"; do
  echo "==> build $s"
  $OC -n "$NAMESPACE" start-build "$s" --from-dir="$ROOT/services/$s" --follow --wait
done
