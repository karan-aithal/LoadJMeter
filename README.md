# Distributed Load Testing Platform

A production-grade, self-hosted load testing platform built phase-by-phase.  
Stack: Node.js · k6 · Redis · Postgres · Prometheus · Grafana · Helm · KEDA · React

## Architecture

```
┌──────────┐   POST /tests   ┌─────────────┐   LPUSH   ┌───────┐
│    UI    │────────────────▶│ Control API │──────────▶│ Redis │
└──────────┘                 └─────────────┘           └───┬───┘
                                    │                      │ BRPOPLPUSH
                                    │ PATCH /status        ▼
                                    │               ┌────────────┐   k6 run   ┌─────┐
                                    └───────────────│   Worker   │───────────▶│ SUT │
                                                    └──────┬─────┘            └──┬──┘
                                                           │ /metrics            │ /metrics
                                                    ┌──────▼──────────────────────▼──────┐
                                                    │         Prometheus + Grafana        │
                                                    └─────────────────────────────────────┘
```

## Quick Start (Docker Compose)

```bash
cp .env.example .env
# Fill in: JWT_SECRET (32+ chars), API_KEY (any string)

docker compose up --build -d

# Services:
#   UI           http://localhost:5173
#   Control API  http://localhost:4000/api-docs
#   Grafana      http://localhost:3001  (admin / admin)
#   Prometheus   http://localhost:9090
```

## Quick Start (Kubernetes / kind)

```bash
kind create cluster --name loadtest
make k8s-deploy JWT_SECRET=$(openssl rand -hex 32) API_KEY=$(openssl rand -hex 16)
make k8s-status
kubectl -n loadtest-system port-forward svc/grafana 3001:3000
```

## Operator Dashboard

Log in to the UI (JWT, role `operator`). Tabs:

| Tab | What it shows |
|-----|---------------|
| Runs | Launch form, history, cancel, **Retry** on failed/cancelled runs (creates a new run) |
| Pipeline | Live node/edge diagram: UI → Control API → `jobs:pending` → `jobs:processing` → workers → Postgres, plus DLQ and reaper. Click a node for details; pause freezes the animation |
| Queues | Contents of `jobs:pending` / `jobs:processing` / `jobs:dead-letter`; **Requeue** or **Purge** DLQ entries; reaped and fenced-write counters |
| Chaos | Recorded worker-kill / partition runs from `docs/benchmarks/results/*.json`: pass rate, lost jobs, duplicate completions, MTTR p50/p95, per-run timeline. Read-only; warns when runs came from different git SHAs |

Live data comes from the SSE feed `GET /api/ops/stream` (every `OPS_STREAM_MS`, default 2000; the UI can pause it and pick 1/2/5/10 s via `?ms=`). The browser's `EventSource` cannot set headers, so the JWT goes in `?token=` for that one route (it can appear in access logs). If the stream fails the UI falls back to polling.

### Controls (operator)

- **Pipeline**: drag boxes (or focus one and use the arrow keys) to rearrange; the layout is saved in the browser (Reset layout). **Expand** fills the screen (Esc closes). Click a box or a connection for its details (transport, key/endpoint, auth, live numbers) and its controls.
- **Runtime settings**, edited from the reaper / connection panels and the Queues tab, applied live and shared with the workers through Redis (`ops:settings`; env vars are only the defaults): `reaperPaused`, `reaperStaleMs`, `reaperIntervalMs`, `maxRetries`, `heartbeatIntervalMs` (from the next job), `intakePaused` (new `POST /tests` get 503).
- **Reaper**: pause/resume, tune, run a pass now. **Queues / DLQ**: requeue all, purge DLQ, purge pending (cancels each run), pause intake.
- **Workers**: every live worker (idle or busy) reports presence. Commands: pause / resume intake, drain (finish the job, then exit), crash (exit at once), partition (heartbeats and status writes fail for 5-300 s, so the reaper requeues and the fenced worker is rejected on return).
- **Chaos tab**: a one-click kill-worker experiment (launch a job, kill its worker, time the reaper's recovery), the worker table, a real-infrastructure panel and the audit log.

Safety: crash / drain / partition / infra actions answer 403 until chaos is enabled. Enable it from the **Chaos tab** ("Enable chaos", needs a typed confirmation; stored as the runtime setting `chaosEnabled`, applies at once, "Disable chaos" reverts) or set `CHAOS_ENABLED=true` on control-api as the default (`false` out of the box). The UI asks you to type the action name, and every operator action is written to an audit log (`GET /ops/audit`, shown in the Chaos tab).

Real kills (container / pod) are a second opt-in. Compose: `docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d control-api` mounts the Docker socket (root on the host: dev machines only) and only ever acts on `worker` containers. Helm: `--set chaos.enabled=true --set chaos.realKill=true` adds a Role limited to pods (kill and restart; partition stays with `infra/scripts/chaos-partition-worker.sh`). OKD gets the soft controls only (`CHAOS_ENABLED` in the ConfigMap).

Operator API (JWT `operator` only, documented in `/api-docs`): `GET /ops/queues`, `GET /ops/stream`, `POST /ops/dlq/{id}/requeue`, `DELETE /ops/dlq/{id}`, `GET /ops/chaos`, `POST /tests/{id}/retry`, plus `GET|PUT /ops/settings`, `POST /ops/reaper/run`, `POST /ops/queues/{pending|dlq}/purge`, `POST /ops/queues/dlq/requeue`, `GET /ops/workers`, `POST /ops/workers/{id}/{cmd}`, `GET /ops/infra`, `POST /ops/infra/{action}`, `GET /ops/audit`. `PATCH /tests/{id}/status` and the heartbeat require the worker `x-api-key`. `GET /metrics` exposes `reaped_total` and `fenced_writes_total` for Prometheus.

Chaos data source: control-api reads `RESULTS_DIR` (compose mounts `docs/benchmarks/results` read-only at `/results`). On OKD run `make okd-results` after new chaos runs (`okd-deploy` does it too).

## Phase Completion

| Phase | Status | Artifact |
|-------|--------|----------|
| 0 — SUT                      | ✅ | `services/sut` — 3 endpoints + /metrics + SLOs |
| 1 — k6 worker manual run     | ✅ | `services/worker/scripts/k6` — thresholds + stages |
| 2 — Control API              | ✅ | Auth + idempotent POST /tests + queue dispatch |
| 3 — Queue-driven fleet       | ✅ | Atomic dequeue, retry, dead-letter, heartbeat, reaper (requeues jobs from dead workers) |
| 4 — Metrics + dashboards     | ✅ | Prometheus RED/USE + Grafana + INCONCLUSIVE verdict |
| 5 — Kubernetes / Helm        | ✅ | Helm chart, NetworkPolicy, resource limits, PDB |
| 6 — KEDA autoscaling         | ✅ | ScaledObject + chaos test scripts + runbooks |
| 7 — React UI                 | ✅ | Launch form + live status + Grafana embeds + operator dashboard (Pipeline, Queues, Chaos) |
| 8 — CI/CD + security         | ✅ | GitHub Actions: lint → test → build → Trivy → smoke; GitLab CI: lint + test, UI build, helm lint |
| 9 — Multi-region + RBAC      | 🔜 | LocalStack SQS, region routing, JWT RBAC |

## Services

| Service | Path | Port | README |
|---------|------|------|--------|
| SUT (System Under Test) | `services/sut` | 3000 | [→](services/sut/README.md) |
| Control API | `services/control-api` | 4000 | [→](services/control-api/README.md) |
| Worker | `services/worker` | 9464 (metrics) | [→](services/worker/README.md) |
| UI | `services/ui` | 5173 | [→](services/ui/README.md) |

## Runbooks

- [Queue Stuck](docs/runbooks/queue-stuck.md)
- [Worker Crash Loop](docs/runbooks/worker-crash-loop.md)
- [SLO Breach](docs/runbooks/slo-breach.md)

## Benchmarks

- [Chaos recovery](docs/benchmarks/chaos-recovery.md): worker kill / network partition results and method

## Makefile Targets

```
make up              # docker compose up --build -d
make down            # docker compose down
make test            # npm test for sut + worker + control-api
make k8s-deploy      # helm upgrade --install (requires kind cluster; passes the Grafana files with --set-file)
make helm-lint       # lint the chart (same --set-file inputs)
make okd-results     # publish chaos results for the dashboard's Chaos tab on OKD
make keda-install    # install KEDA into cluster (kind/Helm path)
make keda-apply      # apply ScaledObject
make okd-keda-install okd-keda-apply   # same for OKD (see infra/okd/README.md)
make load-queue N=6  # push 6 jobs → time scale-up to 5 workers
make chaos-kill      # kill worker mid-job → verify requeue
```

## Environment Variables

See [.env.example](.env.example) — copy to `.env`, never commit `.env`.

## Security

- No open endpoints: all API routes require JWT Bearer token
- Secrets: K8s Secrets only — never in manifests or `.env` committed
- Images: Trivy-scanned in CI, no CRITICAL CVEs allowed to ship
- Non-root containers: all services run as UID 1000 / appuser
