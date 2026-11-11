#!/usr/bin/env bash
# Configure the HOST PostgreSQL for TLS-only access from the CRC node network.
# Dry-run by default (prints what would change). Review, then run with --apply as root:
#   sudo infra/okd/postgres-tls/apply-on-postgres-host.sh --apply
# Touches: <confdir>/tls/*, <confdir>/conf.d/50-loadjmeter-tls.conf, pg_hba.conf (marked block), ufw (if active).
# Restarts the cluster (listen_addresses change needs it) - other local apps using it see a brief blip.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../okd.env"; [[ -f "$HERE/../okd.env.local" ]] && . "$HERE/../okd.env.local"
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
CONF=/etc/postgresql/$PG_VERSION/$PG_CLUSTER
OUT="$HERE/out"
BEGIN="# BEGIN loadjmeter (managed by apply-on-postgres-host.sh)"; END="# END loadjmeter"

[[ -f "$OUT/server.crt" ]] || { echo "run gen-certs.sh first" >&2; exit 1; }
[[ -d $CONF ]] || { echo "no $CONF - set PG_VERSION/PG_CLUSTER in okd.env.local" >&2; exit 1; }

HBA_BLOCK="$BEGIN
hostssl    $PG_DB  $PG_USER  $PG_CIDR  scram-sha-256
hostnossl  all     all       $PG_CIDR  reject
$END"
CONF_DROPIN="# managed by apply-on-postgres-host.sh
ssl = on
ssl_cert_file = '$CONF/tls/server.crt'
ssl_key_file  = '$CONF/tls/server.key'
ssl_min_protocol_version = 'TLSv1.2'
# '*' because the CRC bridge IP does not exist until CRC is running; access is limited by pg_hba + firewall.
listen_addresses = '*'"

echo "== conf.d drop-in ($CONF/conf.d/50-loadjmeter-tls.conf)"; echo "$CONF_DROPIN"
echo; echo "== pg_hba.conf block (inserted above existing rules)"; echo "$HBA_BLOCK"
echo; echo "== firewall: allow tcp/5432 from $PG_CIDR only (ufw: $(command -v ufw >/dev/null && ufw status 2>/dev/null | head -1 || echo absent))"
echo; echo "== finally: restart $PG_VERSION/$PG_CLUSTER, provision DB/role"
(( APPLY )) || { echo; echo "DRY RUN - nothing changed. Re-run with --apply."; exit 0; }
[[ $EUID -eq 0 ]] || { echo "--apply needs root (sudo)" >&2; exit 1; }

TS=$(date +%Y%m%d-%H%M%S)
cp -a "$CONF/pg_hba.conf" "$CONF/pg_hba.conf.bak-$TS"
install -d -o postgres -g postgres -m 750 "$CONF/tls"
install -o postgres -g postgres -m 644 "$OUT/server.crt" "$CONF/tls/server.crt"
install -o postgres -g postgres -m 600 "$OUT/server.key" "$CONF/tls/server.key"
echo "$CONF_DROPIN" > "$CONF/conf.d/50-loadjmeter-tls.conf"

# idempotent pg_hba block: drop old one, prepend new (first match wins)
python3 - "$CONF/pg_hba.conf" "$BEGIN" "$END" "$HBA_BLOCK" <<'PY'
import sys,re
p,b,e,blk=sys.argv[1:5]
s=open(p).read()
s=re.sub(re.escape(b)+r".*?"+re.escape(e)+r"\n?","",s,flags=re.S)
open(p,"w").write(blk+"\n"+s)
PY

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "$PG_CIDR" to any port 5432 proto tcp comment loadjmeter-okd
fi

pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" restart
sleep 2
sudo -u postgres psql -Atc "show ssl; show listen_addresses; show ssl_cert_file;"
if [[ -n "${LOADJ_DB_PASSWORD:-}" ]]; then
  sudo -u postgres psql -v pw="$LOADJ_DB_PASSWORD" -f "$HERE/provision-db.sql"
else
  sudo -u postgres psql -f "$HERE/provision-db.sql"
fi
echo "done. Backup of pg_hba.conf: $CONF/pg_hba.conf.bak-$TS"
