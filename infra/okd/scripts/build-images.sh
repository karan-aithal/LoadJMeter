#!/usr/bin/env bash
# Build images inside the cluster into the OKD internal registry (binary Docker builds) and mirror redis.
# Usage: build-images.sh [service...]   (default: all)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
OC=${OC:-oc}; SERVICES=("$@"); (( ${#SERVICES[@]} )) || SERVICES=(sut control-api worker ui)

$OC -n "$NAMESPACE" apply -f "$HERE/../base/imagestreams.yaml" -f "$HERE/../base/buildconfigs.yaml"
$OC -n "$NAMESPACE" import-image redis:7.2-alpine --from=docker.io/library/redis:7.2-alpine --confirm >/dev/null
for s in "${SERVICES[@]}"; do
  echo "==> build $s"
  $OC -n "$NAMESPACE" start-build "$s" --from-dir="$ROOT/services/$s" --follow --wait
done
