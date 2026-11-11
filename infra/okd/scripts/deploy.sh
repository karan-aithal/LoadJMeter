#!/usr/bin/env bash
# Preflight -> project -> secrets -> images -> apply -> rollout -> smoke.
# Prereqs: CRC/OKD running + `oc login`; infra/okd/postgres-tls/apply-on-postgres-host.sh already applied.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
OC=${OC:-oc}

$OC whoami >/dev/null || { echo "not logged in: oc login -u kubeadmin https://api.crc.testing:6443" >&2; exit 1; }
[[ -f "$HERE/../postgres-tls/out/ca.crt" ]] || { echo "run: make okd-tls" >&2; exit 1; }

# the host must be reachable from the node network on the expected IP
if ip addr show crc >/dev/null 2>&1; then
  ACTUAL=$(ip -4 addr show crc | awk '/inet /{sub("/.*","",$2);print $2}')
  [[ "$ACTUAL" == "$PG_HOST_IP" ]] || { echo "PG_HOST_IP=$PG_HOST_IP but crc bridge is $ACTUAL: set PG_HOST_IP/PG_CIDR in infra/okd/okd.env.local and regenerate certs" >&2; exit 1; }
fi

$OC get ns "$NAMESPACE" >/dev/null 2>&1 || $OC new-project "$NAMESPACE" >/dev/null
bash "$HERE/create-secrets.sh"
bash "$HERE/build-images.sh"

# base/ is written for the CRC default IP; rewrite if overridden
$OC kustomize "$HERE/../overlays/crc" | sed -E "s#192\.168\.130\.1([^0-9]|$)#${PG_HOST_IP}\1#g" | $OC apply -f -
# CRC's /etc/hosts entry only has its fixed names, so route hosts need their own marked line (needs sudo)
RH=$($OC -n "$NAMESPACE" get route -o jsonpath='{.items[*].spec.host}'); CIP=$(getent hosts api.crc.testing | awk '{print $1}')
getent hosts $RH >/dev/null || sudo sh -c "sed -i '/# loadjmeter-okd\$/d' /etc/hosts && echo '$CIP $RH # loadjmeter-okd' >> /etc/hosts" \
  || echo "WARN: add manually to /etc/hosts: $CIP $RH" >&2
$OC -n "$NAMESPACE" rollout restart deploy/control-api deploy/worker deploy/sut deploy/ui >/dev/null
for d in redis sut control-api worker ui; do $OC -n "$NAMESPACE" rollout status "deploy/$d" --timeout=300s; done

echo; $OC -n "$NAMESPACE" get pods,route
bash "$HERE/smoke.sh"
