#!/usr/bin/env bash
# Generate a private CA + PostgreSQL server cert into postgres-tls/out/ (gitignored).
# SANs cover the in-cluster service name, the host bridge IP, and localhost (for host-side tests).
# Usage: infra/okd/postgres-tls/gen-certs.sh [--force]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
OUT="$HERE/out"
mkdir -p "$OUT"; chmod 700 "$OUT"

if [[ -f "$OUT/server.crt" && "${1:-}" != "--force" ]]; then
  echo "certs already exist in $OUT (use --force to regenerate)"; exit 0
fi

SAN="DNS:postgres-external,DNS:postgres-external.${NAMESPACE}.svc,DNS:postgres-external.${NAMESPACE}.svc.cluster.local,DNS:localhost,IP:127.0.0.1,IP:${PG_HOST_IP}"

openssl genrsa -out "$OUT/ca.key" 4096 2>/dev/null
openssl req -x509 -new -nodes -key "$OUT/ca.key" -sha256 -days 3650 \
  -subj "/O=LoadJMeter/CN=LoadJMeter Postgres CA" -out "$OUT/ca.crt"

# CSR is piped (no temp files); extensions come from process substitution; random serial (no .srl file)
openssl genrsa -out "$OUT/server.key" 2048 2>/dev/null
openssl req -new -key "$OUT/server.key" -subj "/O=LoadJMeter/CN=postgres-external" \
  | openssl x509 -req -in /dev/stdin -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
      -set_serial "0x$(openssl rand -hex 16)" -days 825 -sha256 \
      -extfile <(printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN") \
      -out "$OUT/server.crt" 2>/dev/null
chmod 600 "$OUT"/*.key; chmod 644 "$OUT"/*.crt

openssl verify -CAfile "$OUT/ca.crt" "$OUT/server.crt"
echo "SANs: $SAN"
echo "CA (public, goes to the cluster): $OUT/ca.crt"
echo "Next: sudo infra/okd/postgres-tls/apply-on-postgres-host.sh   (dry-run by default; add --apply)"
