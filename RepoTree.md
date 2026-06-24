distributed-load-test-platform/
├── README.md
├── LICENSE
├── .gitignore
├── .env.example
├── docker-compose.yml
├── docker-compose.k8s-local.yml
├── Makefile
│
├── docs/
│   ├── architecture.md
│   ├── architecture-diagram.png
│   ├── slo.md
│   ├── runbooks/
│   │   ├── queue-stuck.md
│   │   ├── worker-crash-loop.md
│   │   └── slo-breach.md
│   └── api-spec/
│       └── openapi.yaml
│
├── services/
│   │
│   ├── sut/                              # Phase 0 — System Under Test
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.js
│   │   │   ├── routes/
│   │   │   │   ├── fast.js
│   │   │   │   ├── slow.js
│   │   │   │   └── cpu-heavy.js
│   │   │   ├── health/
│   │   │   │   ├── healthz.js
│   │   │   │   └── readyz.js
│   │   │   ├── metrics/
│   │   │   │   └── prometheus.js
│   │   │   ├── logger/
│   │   │   │   └── logger.js
│   │   │   └── middleware/
│   │   │       └── trace-id.js
│   │   └── test/
│   │       └── routes.test.js
│   │
│   ├── control-api/                      # Phase 2 — Control plane
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.js
│   │   │   ├── routes/
│   │   │   │   ├── tests.js              # POST/GET/DELETE /tests
│   │   │   │   └── auth.js
│   │   │   ├── middleware/
│   │   │   │   ├── auth.js               # API key / JWT
│   │   │   │   ├── idempotency.js
│   │   │   │   └── validate.js
│   │   │   ├── queue/
│   │   │   │   └── redis-producer.js
│   │   │   ├── db/
│   │   │   │   ├── client.js
│   │   │   │   └── repositories/
│   │   │   │       └── test-run-repo.js
│   │   │   └── openapi/
│   │   │       └── generate.js
│   │   ├── migrations/                   # Flyway/Prisma/Alembic-style
│   │   │   ├── 001_init.sql
│   │   │   ├── 002_test_runs.sql
│   │   │   └── 003_indexes.sql
│   │   └── test/
│   │       └── tests-route.test.js
│   │
│   ├── worker/                           # Phase 1/3 — Test fleet
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── scripts/
│   │   │   ├── k6/
│   │   │   │   ├── base-scenario.js
│   │   │   │   ├── fast-endpoint.js
│   │   │   │   ├── slow-endpoint.js
│   │   │   │   └── cpu-heavy.js
│   │   │   └── thresholds.js
│   │   ├── src/
│   │   │   ├── index.js                  # boot, pull job
│   │   │   ├── queue/
│   │   │   │   ├── redis-consumer.js     # atomic pop, dead-letter
│   │   │   │   └── dead-letter.js
│   │   │   ├── runner/
│   │   │   │   ├── k6-runner.js
│   │   │   │   └── result-parser.js
│   │   │   ├── lifecycle/
│   │   │   │   └── graceful-shutdown.js  # SIGTERM handling
│   │   │   ├── heartbeat/
│   │   │   │   └── heartbeat.js
│   │   │   └── metrics/
│   │   │       └── prometheus-exporter.js
│   │   └── test/
│   │       └── runner.test.js
│   │
│   └── ui/                               # Phase 7 — Dashboard
│       ├── Dockerfile
│       ├── package.json
│       ├── public/
│       │   └── index.html
│       └── src/
│           ├── App.jsx
│           ├── api/
│           │   └── client.js
│           ├── components/
│           │   ├── TestForm.jsx
│           │   ├── TestHistoryTable.jsx
│           │   ├── LiveStatus.jsx
│           │   ├── VerdictBadge.jsx
│           │   └── GrafanaEmbed.jsx
│           └── pages/
│               ├── Dashboard.jsx
│               └── TestDetail.jsx
│
├── infra/
│   │
│   ├── docker/
│   │   └── base-images/
│   │       └── node-base.Dockerfile
│   │
│   ├── k8s/                              # Phase 5
│   │   ├── namespace.yaml
│   │   ├── helm/
│   │   │   ├── Chart.yaml
│   │   │   ├── values.yaml
│   │   │   ├── values-local.yaml
│   │   │   └── templates/
│   │   │       ├── sut-deployment.yaml
│   │   │       ├── control-api-deployment.yaml
│   │   │       ├── worker-deployment.yaml
│   │   │       ├── postgres-statefulset.yaml
│   │   │       ├── redis-deployment.yaml
│   │   │       ├── prometheus-deployment.yaml
│   │   │       ├── grafana-deployment.yaml
│   │   │       ├── services.yaml
│   │   │       ├── configmaps.yaml
│   │   │       ├── secrets.yaml
│   │   │       ├── networkpolicy.yaml
│   │   │       ├── resource-limits.yaml
│   │   │       └── pdb.yaml
│   │   └── keda/                         # Phase 6
│   │       ├── scaledobject-worker.yaml
│   │       └── trigger-auth-redis.yaml
│   │
│   ├── monitoring/                       # Phase 4
│   │   ├── prometheus/
│   │   │   ├── prometheus.yml
│   │   │   └── alert-rules.yml
│   │   ├── alertmanager/
│   │   │   └── alertmanager.yml
│   │   └── grafana/
│   │       ├── provisioning/
│   │       │   ├── datasources.yml
│   │       │   └── dashboards.yml
│   │       └── dashboards/
│   │           ├── fleet-dashboard.json
│   │           └── sut-dashboard.json
│   │
│   └── scripts/
│       ├── seed-db.sh
│       ├── load-queue-test.sh
│       └── chaos-kill-worker.sh
│
├── .github/
│   └── workflows/
│       ├── ci.yml                        # lint, test, build, scan
│       └── k6-smoke-test.yml
│
└── shared/
    ├── types/                            # shared TS types/interfaces if TS used
    │   └── test-config.ts
    └── constants/
        └── queue-keys.js

        