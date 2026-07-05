#!/usr/bin/env bash
# seed-db.sh — runs pending database migrations against a running Postgres instance.
# Usage:
#   NAMESPACE=loadtest-system ./infra/scripts/seed-db.sh
#   OR: DATABASE_URL=postgresql://... ./infra/scripts/seed-db.sh
set -euo pipefail

NS=${NAMESPACE:-loadtest-system}
MIGRATIONS_DIR="$(dirname "$0")/../../services/control-api/migrations"

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "==> Using DATABASE_URL"
  PSQL_ARGS=("$DATABASE_URL")
else
  echo "==> Port-forwarding postgres in $NS"
  kubectl -n "$NS" port-forward svc/postgres 15432:5432 &
  PF_PID=$!
  sleep 2
  DB_USER=$(kubectl -n "$NS" get configmap loadtest-config -o jsonpath='{.data.POSTGRES_USER}')
  DB_NAME=$(kubectl -n "$NS" get configmap loadtest-config -o jsonpath='{.data.POSTGRES_DB}')
  DB_PASS=$(kubectl -n "$NS" get secret loadtest-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
  export PGPASSWORD="$DB_PASS"
  PSQL_ARGS=("-h" "localhost" "-p" "15432" "-U" "$DB_USER" "-d" "$DB_NAME")
fi

cleanup() { kill "${PF_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> Running migrations from $MIGRATIONS_DIR"
for sql_file in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  echo "  Applying: $(basename "$sql_file")"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "${PSQL_ARGS[@]}" -f "$sql_file"
  else
    psql "${PSQL_ARGS[@]}" -f "$sql_file"
  fi
done

echo "DONE — migrations applied"
