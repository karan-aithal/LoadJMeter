#!/usr/bin/env bash
# Create Secrets + the CA ConfigMap in the cluster. Nothing is written to disk or printed.
# Sources: DB password <- $PG_PASSWORD or loadjmeter.env.local (host part of that file is ignored);
#          JWT_SECRET / API_KEY <- env or repo .env.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
OC=${OC:-oc}

if [[ -z "${PG_PASSWORD:-}" && -f "$ROOT/loadjmeter.env.local" ]]; then
  PG_PASSWORD=$(sed -nE 's#^(DATABASE_URL=)?postgres(ql)?://[^:]+:([^@]*)@.*#\3#p' "$ROOT/loadjmeter.env.local" | head -1)
fi
[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }
: "${PG_PASSWORD:?set PG_PASSWORD or provide loadjmeter.env.local}" "${JWT_SECRET:?}" "${API_KEY:?}"

ENC=$(python3 -c 'import sys,urllib.parse as u;print(u.quote(sys.argv[1],safe=""))' "$PG_PASSWORD")
DATABASE_URL="postgresql://${PG_USER}:${ENC}@postgres-external:5432/${PG_DB}?sslmode=verify-full&sslrootcert=/etc/pg-ca/ca.crt"

apply(){ $OC -n "$NAMESPACE" "$@" --dry-run=client -o yaml | $OC -n "$NAMESPACE" apply -f - >/dev/null; }
apply create secret generic control-api-secrets \
  --from-literal=DATABASE_URL="$DATABASE_URL" --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=API_KEY="$API_KEY"
apply create secret generic worker-secrets --from-literal=WORKER_API_KEY="$API_KEY"
apply create configmap pg-ca --from-file=ca.crt="$HERE/../postgres-tls/out/ca.crt"
echo "secrets control-api-secrets, worker-secrets and configmap pg-ca applied in $NAMESPACE"
