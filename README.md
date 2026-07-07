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

## Phase Completion

| Phase | Status | Artifact |
|-------|--------|----------|
| 0 — SUT                      | ✅ | `services/sut` — 3 endpoints + /metrics + SLOs |
| 1 — k6 worker manual run     | ✅ | `services/worker/scripts/k6` — thresholds + stages |
| 2 — Control API              | ✅ | Auth + idempotent POST /tests + queue dispatch |
| 3 — Queue-driven fleet       | ✅ | Atomic dequeue, retry, dead-letter, heartbeat |
| 4 — Metrics + dashboards     | ✅ | Prometheus RED/USE + Grafana + INCONCLUSIVE verdict |
| 5 — Kubernetes / Helm        | ✅ | Helm chart, NetworkPolicy, resource limits, PDB |
| 6 — KEDA autoscaling         | ✅ | ScaledObject + chaos test scripts + runbooks |
| 7 — React UI                 | ✅ | Launch form + live status + Grafana embeds |
| 8 — CI/CD + security         | ✅ | GitHub Actions: lint → test → build → Trivy → smoke |
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

## Makefile Targets

```
make up              # docker compose up --build -d
make down            # docker compose down
make test            # npm test for sut + worker
make k8s-deploy      # helm upgrade --install (requires kind cluster)
make keda-install    # install KEDA into cluster
make keda-apply      # apply ScaledObject
make load-queue N=5  # push 5 jobs → watch scale-up
make chaos-kill      # kill worker mid-job → verify requeue
```

## Environment Variables

See [.env.example](.env.example) — copy to `.env`, never commit `.env`.

## Security

- No open endpoints: all API routes require JWT Bearer token
- Secrets: K8s Secrets only — never in manifests or `.env` committed
- Images: Trivy-scanned in CI, no CRITICAL CVEs allowed to ship
- Non-root containers: all services run as UID 1000 / appuser

docker compose up --build
# SUT:        http://localhost:3000/metrics
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3001 (admin/admin)

# Add to .env:  JWT_SECRET=<32+ chars>  API_KEY=<any string>
docker compose up --build -d
# Get token:
curl -X POST http://localhost:4000/auth/token -H 'Content-Type: application/json' -d '{"apiKey":"<your_API_KEY>"}'
# Swagger UI: http://localhost:4000/api-docs


# Required env
# API_KEY=<your_key>
# JWT_SECRET=<32+ chars>

docker compose up --build -d
docker compose up -d --scale worker=3 worker

docker compose kill worker
docker compose up -d --scale worker=3 worker

Next run commands:

Start stack
docker compose up --build -d
Scale workers
docker compose up -d --scale worker=3 worker
Open monitoring
Grafana: http://localhost:3001
Prometheus: http://localhost:9090

Worker exposes:
/metrics on port 9464
/healthz and /readyz
Worker records:
worker_jobs_total by outcome
worker_current_job
worker_queue_poll_total
worker_heartbeat_failures_total
worker_cpu_saturation_ratio
worker_saturation_breaches_total


# To deploy to a local kind cluster:
kind create cluster --name loadtest
JWT_SECRET=$(openssl rand -hex 32) API_KEY=$(openssl rand -hex 16) make k8s-deploy
make k8s-status
make k8s-scale N=3
kubectl -n loadtest-system logs -l app=worker -f


# Chaos test flow:
make k8s-deploy         # stack up
make keda-apply         # ScaledObject active
make load-queue N=5     # 5 jobs → workers scale 1→5
make chaos-kill         # kill mid-run → job requeues → new worker picks up

To run locally:
cp .env.example .env   # fill JWT_SECRET, API_KEY
docker compose up --build -d
# UI: http://localhost:5173