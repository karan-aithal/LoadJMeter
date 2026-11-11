# OKD deployment (CRC okd preset) with external TLS PostgreSQL

App runs on a single-node OKD on this machine; PostgreSQL stays on the Linux host (outside the cluster),
reached over TLS (`verify-full`, private CA). Images are built in-cluster into the OKD internal registry.

```
pod control-api --TLS--> Service postgres-external -> Endpoints 192.168.130.1:5432 (host, CRC bridge IP; needs `network-mode system`)
```

## One-time prerequisites (manual)
1. BIOS: enable VT-x / AMD-V. `make okd-prereqs` must pass (needs >= 16 GB free RAM, 35 GB disk, /dev/kvm, `libvirt` group).
2. `make okd-tools` (oc/kubectl/crc into `~/bin`), then:
   `crc config set preset okd && crc config set network-mode system && crc config set memory 16384 && crc setup && crc start`, then `oc login -u kubeadmin https://api.crc.testing:6443`.
   **`network-mode system` is required.** CRC's default (`user`) has no `crc` bridge, and its VM and pods cannot reach host
   loopback or any `192.168.127.x` address, so the host PostgreSQL is unreachable. Switching an existing install:
   `crc stop && crc config set network-mode system && crc cleanup && crc setup && crc start` (setup needs sudo).
3. Check the host bridge IP: `ip addr show crc` (this device does not exist in `user` mode). If it is not `192.168.130.1`, create `infra/okd/okd.env.local` with `PG_HOST_IP` and `PG_CIDR`.

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
- Not included: Prometheus/Grafana/Alertmanager and KEDA by default (use OKD user-workload monitoring / Custom Metrics Autoscaler later). KEDA is an optional add-on, see below.
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

## Optional: KEDA worker autoscaling (separate lifecycle)
Deploy paths differ: `make k8s-deploy` uses the Helm chart (kind); `make okd-deploy` uses these Kustomize manifests. They share the app, not the deployment.
KEDA is **not** installed or removed by `okd-deploy`; it has its own targets:
```bash
make okd-keda-install   # helm: KEDA 2.14.0 into ns keda, values: infra/okd/keda-values.yaml (SCC-friendly, no fixed UIDs)
make okd-keda-apply     # allow-keda-to-redis NetworkPolicy + TriggerAuthentication + ScaledObject (worker 1..10)
make load-queue N=6     # timed scale-up test (N must exceed the target of 5)
make okd-keda-down      # delete the above and uninstall KEDA
```
- Once the ScaledObject exists, KEDA owns `worker` replicas (1..10); the `replicas: 2` in `base/worker.yaml` no longer applies. After `okd-keda-down` the Deployment keeps its last replica count; scale it by hand.
- The namespace denies ingress by default, so `keda-networkpolicy.yaml` lets the `keda` namespace reach Redis on 6379.
- The metric is `LLEN jobs:pending` (target 1 per replica). Jobs already popped by a worker do not count.
- CPU: worker requests 250m (limit 1). On a 3.8-CPU CRC node only ~3 workers fit, so extra pods go `Pending: Insufficient cpu`. Measured numbers are in `docs/slo.md`.
