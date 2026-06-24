# Distributed Load Testing Platform — Build Prompt (Phased)

CAVEMAN MODE ON.
- No filler. No politeness. No repeat.
- Short sentences. Keywords + symbols (→ = vs).
- Assume user smart, some K8s exp.
- Shortest correct answer only. Explain only if asked.

STACK: local K8s (minikube/kind) + k6 workers + Redis queue + KEDA autoscale + Prometheus/Grafana + custom toy app as SUT.

GOAL: build in phases. Each phase = runnable artifact. No skip ahead.

---

## PHASE 0 — SUT (toy app)
- Build small API (Node/Express or Python/FastAPI). Pick one, stick with it.
- 3 endpoints min: fast, slow (artificial delay), CPU-heavy (fib/prime calc).
- Health endpoints: `/healthz` (liveness), `/readyz` (readiness) — separate concerns.
- Structured JSON logs. Include trace_id per request.
- Expose `/metrics` (Prometheus): latency histogram, req count, error count, in-flight gauge.
- Define SLOs upfront: e.g. p95 < 200ms, error rate < 1%. Write down → pass/fail criteria later.
- Dockerize: multi-stage build, non-root user, pinned base image digest.
- docker-compose up → confirm /metrics scrapeable + SLOs measurable.

OUTPUT: SUT container + Dockerfile + /metrics + health checks + documented SLOs.

---

## PHASE 1 — Single worker, manual run
- Write k6 script. Target SUT endpoints. Configurable VUs/duration/ramp via env vars.
- Use k6 `thresholds`: tie to SUT SLOs (p95, error rate) → script exits non-zero on breach. Makes this CI-usable later.
- Stages: ramp-up → steady → ramp-down. Not flat spike — realistic profile.
- Dockerize k6 + script → "worker" image. Pin k6 version.
- Run manually: confirm load registers in SUT metrics + threshold pass/fail reported.

OUTPUT: worker image, threshold-driven pass/fail, manual single-run proof.

---

## PHASE 2 — Control plane (API)
- Build control API. Auth: API key or JWT — no open endpoints, even local.
- Endpoints: POST /tests (idempotency key required) → GET /tests/:id → GET /tests (paginated) → DELETE /tests/:id (cancel).
- Input validation: reject bad VU counts/durations (guardrails — don't let user nuke own laptop or prod by accident).
- Postgres: use migrations (Flyway/Alembic/Prisma) — not manual SQL. Schema versioned from day 1.
- On POST /tests → push job to Redis queue (idempotent enqueue — dedupe on key).
- Add OpenAPI/Swagger spec — contract before code, or generated from code.

OUTPUT: authenticated control API + versioned schema + jobs landing in Redis + API spec.

---

## PHASE 3 — Worker pulls from queue
- Worker: on boot, pull job (atomic — BRPOPLPUSH or consumer group, no double-pickup).
- Graceful shutdown: SIGTERM → finish/abort current run cleanly, don't orphan job.
- Retry policy: failed job → retry N times → then dead-letter queue (don't retry forever).
- Heartbeat to control API (job alive/stalled detection).
- Run 2-3 workers manually (compose scale) → confirm distribution, no double-pickup, dead-letter works (kill worker mid-job, verify recovery).

OUTPUT: queue-driven fleet, graceful shutdown, retry + dead-letter, crash-tested.

---

## PHASE 4 — Metrics + dual dashboards + alerting
- Prometheus scrapes SUT + worker /metrics (k6 via xk6-prometheus or experimental-rtm output).
- Apply RED method on SUT (Rate, Errors, Duration) + USE method on fleet (Utilization, Saturation, Errors).
- Grafana: "Fleet" (worker count, VUs, CPU/mem sat) + "SUT" (p50/p95/p99, error rate, throughput) + correlate timeline (test start/stop annotations).
- Alerting rules (Alertmanager or Grafana alerts): fleet CPU saturation >80% → flag results unreliable. SUT error rate breach → flag SLO violation.
- Result must self-report verdict: PASS/FAIL/INCONCLUSIVE (inconclusive = fleet was bottleneck, not SUT).

OUTPUT: Prometheus+Grafana stack, RED/USE dashboards, alerting, automatic test verdicts.

---

## PHASE 5 — Move to K8s
- minikube/kind cluster. Use Helm charts (or Kustomize) — not raw YAML pile.
- Namespace isolation: `loadtest-system` namespace.
- Resource requests/limits on every Deployment (esp. worker — uncapped k6 can starve node).
- NetworkPolicy: worker fleet can reach SUT + queue only, nothing else.
- Secrets via K8s Secrets (or sealed-secrets) — never hardcode in manifests.
- ConfigMaps for non-secret config.
- Deploy SUT, control API, Postgres, Redis, Prometheus, Grafana.
- Manual `kubectl scale` worker Deployment → confirm queue-driven pickup works in-cluster.

OUTPUT: Helm-deployed stack, namespaced, resource-limited, network-policed, manual scale verified.

---

## PHASE 6 — Autoscale (KEDA)
- Install KEDA.
- ScaledObject on worker Deployment: trigger = Redis queue length.
- Set minReplicas, maxReplicas (cap — don't let fleet eat whole cluster). Cooldown period to avoid flapping.
- PodDisruptionBudget — scale-down doesn't kill in-flight test runs.
- Load queue → confirm auto scale-up → idle → confirm scale-down to min.
- Chaos check: kill a worker pod mid-scale, confirm job requeues (ties back to Phase 3 dead-letter/retry).

OUTPUT: KEDA autoscaling, capped + cooldown-controlled, PDB-protected, chaos-tested.

---

## PHASE 7 — UI polish
- React dashboard: form to launch test (validated) → live status (poll or SSE/WS) → embed Grafana panels → history table → cancel/delete run.
- Show verdict (PASS/FAIL/INCONCLUSIVE) front and center per run.

OUTPUT: usable UI, end-to-end demo-able platform.

---

## PHASE 8 — Industry polish (CI/CD + docs + security)
- CI pipeline (GitHub Actions): lint → unit test → build images → run Phase-1-style k6 smoke test against ephemeral SUT in CI.
- Image scanning (Trivy/Grype) in CI — no critical CVEs shipped.
- README per service: how to run, env vars, architecture diagram.
- Runbook: "queue stuck", "worker crash loop", "SLO breach" — what to check, in order.
- `.env.example` — never commit real secrets/.env.
- Tag versions (semver) on releases.

OUTPUT: CI-gated, scanned, documented, runbook-backed platform — portfolio/production ready.

---

## RULES THROUGHOUT
- Each phase: working artifact before next phase starts.
- No premature optimization. No skipping race-condition/crash checks.
- Every config: env var or file — never hardcoded magic number.
- Every secret: vault/K8s secret — never in repo.
- If stuck >1 phase: state phase num + blocker, ask for help on that phase only.