# OKD deployment (CRC okd preset) with external TLS PostgreSQL

App runs on a single-node OKD on this machine; PostgreSQL stays on the Linux host (outside the cluster),
reached over TLS (`verify-full`, private CA). Images are built in-cluster into the OKD internal registry.

```
pod control-api --TLS--> Service postgres-external -> Endpoints 192.168.130.1:5432 (host, CRC bridge IP)
```

## One-time prerequisites (manual)
1. BIOS: enable VT-x / AMD-V. `make okd-prereqs` must pass (needs >= 16 GB free RAM, 35 GB disk, /dev/kvm, `libvirt` group).
2. `make okd-tools` (oc/kubectl/crc into `~/bin`), then:
   `crc config set preset okd && crc config set memory 16384 && crc setup && crc start`, then `oc login -u kubeadmin https://api.crc.testing:6443`.
3. Check the host bridge IP: `ip addr show crc`. If it is not `192.168.130.1`, create `infra/okd/okd.env.local` with `PG_HOST_IP` and `PG_CIDR`.

## Order of operations
```bash
make okd-tls                                   # private CA + server cert -> infra/okd/postgres-tls/out/ (gitignored)
sudo infra/okd/postgres-tls/apply-on-postgres-host.sh            # review the dry-run output
sudo LOADJ_DB_PASSWORD='...' infra/okd/postgres-tls/apply-on-postgres-host.sh --apply
make okd-deploy                                # secrets -> in-cluster builds -> oc apply -k -> rollout -> smoke
```
`apply-on-postgres-host.sh --apply` backs up `pg_hba.conf`, installs the cert, sets `ssl=on` and `listen_addresses='*'`
(bound to everything because the CRC bridge IP does not exist until CRC runs), adds
`hostssl ... scram-sha-256` + `hostnossl ... reject` for the CRC CIDR above all existing rules, adds a ufw rule if ufw is active,
restarts Postgres, and provisions role/DB/`uuid-ossp` (`provision-db.sql`, idempotent).
Existing `pg_hba.conf` rules keep rejecting other LAN hosts; verify with `psql -h <lan-ip>` from another machine.

The DB password is read from `PG_PASSWORD` or the untracked `loadjmeter.env.local` (its host part is ignored).
`JWT_SECRET`/`API_KEY` come from the untracked repo `.env`. Nothing secret is committed or printed.

## Layout
- `base/` plain manifests (restricted-v2 compatible: no fixed UID, non-root, caps dropped, read-only root where possible).
- `overlays/crc/` entry point for `oc kustomize`. `okd.env` has defaults, `okd.env.local` overrides.
- Secrets/CA ConfigMap are created by `scripts/create-secrets.sh`, not by kustomize.
- Not included: Prometheus/Grafana/Alertmanager and KEDA (use OKD user-workload monitoring / Custom Metrics Autoscaler later).
- `control-api` is pinned to 1 replica: migrations run on boot without an advisory lock.

## Verify
```bash
make okd-smoke        # Route -> POST /tests -> completed
make okd-chaos        # kills a worker pod mid-job; prints "Recovered from hard worker kill in N s" (needs the reaper branch merged)
oc -n loadtest-system logs deploy/control-api | grep -E "Migrations complete|Reaper started"
# TLS negative checks (from the host):
PGSSLMODE=disable psql -h 192.168.130.1 -U loadjmeter loadjmeter   # rejected by hostnossl
```

## Rollback
`make okd-down` deletes the project. Restore host Postgres: copy back `pg_hba.conf.bak-<ts>`, delete
`conf.d/50-loadjmeter-tls.conf`, `pg_ctlcluster 14 main restart`.
