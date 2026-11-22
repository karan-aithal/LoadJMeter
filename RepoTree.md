mkdir -p distributed-load-test-platform/{docs/{runbooks,api-spec},services/{sut/{src/{routes,health,metrics,logger,middleware},test},control-api/{src/{routes,middleware,queue,db/repositories,openapi},scripts,migrations,test},worker/{scripts/k6,src/{queue,runner,lifecycle,heartbeat,metrics},test},ui/{public,src/{api,components,hooks,pages}}},infra/{docker/base-images,k8s/helm/templates,k8s/keda,monitoring/{prometheus,alertmanager,grafana/{provisioning/{datasources,dashboards},dashboards}},scripts},.github/workflows,shared/{types,constants}} && touch distributed-load-test-platform/{README.md,LICENSE,.gitignore,.gitlab-ci.yml,.env.example,docker-compose.yml,docker-compose.k8s-local.yml,Makefile,docs/{architecture.md,architecture-diagram.png,slo.md,runbooks/{queue-stuck.md,worker-crash-loop.md,slo-breach.md},api-spec/openapi.yaml},services/{sut/{Dockerfile,package.json,src/{index.js,routes/{fast.js,slow.js,cpu-heavy.js},health/{healthz.js,readyz.js},metrics/prometheus.js,logger/logger.js,middleware/trace-id.js},test/routes.test.js},control-api/{Dockerfile,package.json,src/{index.js,runs.js,metrics.js,routes/{tests.js,auth.js,ops.js},middleware/{auth.js,idempotency.js,validate.js},queue/redis-producer.js,db/{client.js,repositories/test-run-repo.js},openapi/generate.js},scripts/export-openapi.js,migrations/{001_init.sql,002_test_runs.sql,003_indexes.sql},test/{tests-route.test.js,ops.test.js,openapi.test.js}},worker/{Dockerfile,package.json,scripts/{k6/{base-scenario.js,fast-endpoint.js,slow-endpoint.js,cpu-heavy.js},thresholds.js},src/{index.js,queue/{redis-consumer.js,dead-letter.js},runner/{k6-runner.js,result-parser.js},lifecycle/graceful-shutdown.js,heartbeat/heartbeat.js,metrics/prometheus-exporter.js},test/runner.test.js},ui/{Dockerfile,package.json,public/index.html,src/{App.jsx,auth.js,api/client.js,hooks/useOpsStream.js,components/{TestForm.jsx,TestHistoryTable.jsx,LiveStatus.jsx,VerdictBadge.jsx,GrafanaEmbed.jsx},pages/{Dashboard.jsx,TestDetail.jsx,Pipeline.jsx,Queues.jsx,Chaos.jsx}}}},infra/{docker/base-images/node-base.Dockerfile,k8s/{namespace.yaml,helm/{Chart.yaml,values.yaml,values-local.yaml,templates/{sut-deployment.yaml,control-api-deployment.yaml,worker-deployment.yaml,postgres-statefulset.yaml,redis-deployment.yaml,prometheus-deployment.yaml,grafana-deployment.yaml,grafana-configmaps.yaml,services.yaml,configmaps.yaml,secrets.yaml,networkpolicy.yaml,resource-limits.yaml,pdb.yaml}},keda/{scaledobject-worker.yaml,trigger-auth-redis.yaml}},monitoring/{prometheus/{prometheus.yml,alert-rules.yml},alertmanager/alertmanager.yml,grafana/{provisioning/{datasources/datasources.yml,dashboards/dashboards.yml},dashboards/{fleet-dashboard.json,sut-dashboard.json}}},scripts/{seed-db.sh,load-queue-test.sh,chaos-kill-worker.sh}},.github/workflows/{ci.yml,k6-smoke-test.yml},shared/{types/test-config.ts,constants/queue-keys.js}}






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
│   │   │   ├── runs.js                   # launch(config): create run + enqueue
│   │   │   ├── metrics.js                # reaped_total / fenced_writes_total, GET /metrics
│   │   │   ├── routes/
│   │   │   │   ├── tests.js              # POST/GET/DELETE /tests, POST /tests/:id/retry
│   │   │   │   ├── ops.js                # operator API: /ops/queues, /ops/stream (SSE), DLQ requeue/purge, /ops/chaos
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
│   │   │       └── generate.js           # source of truth for docs/api-spec/openapi.yaml
│   │   ├── scripts/
│   │   │   └── export-openapi.js         # npm run spec:yaml
│   │   ├── migrations/                   # Flyway/Prisma/Alembic-style
│   │   │   ├── 001_init.sql
│   │   │   ├── 002_test_runs.sql
│   │   │   └── 003_indexes.sql
│   │   └── test/
│   │       ├── tests-route.test.js
│   │       ├── ops.test.js
│   │       └── openapi.test.js           # route coverage, $ref, YAML == code spec
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
│           ├── auth.js
│           ├── api/
│           │   └── client.js
│           ├── hooks/
│           │   └── useOpsStream.js       # SSE feed, falls back to 3s polling
│           ├── components/
│           │   ├── TestForm.jsx
│           │   ├── TestHistoryTable.jsx
│           │   ├── LiveStatus.jsx
│           │   ├── VerdictBadge.jsx
│           │   └── GrafanaEmbed.jsx
│           └── pages/
│               ├── Dashboard.jsx
│               ├── TestDetail.jsx
│               ├── Pipeline.jsx          # live SVG node/edge diagram
│               ├── Queues.jsx            # queue contents, DLQ requeue/purge
│               └── Chaos.jsx             # recorded chaos/bench results
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
│   │   │       ├── grafana-configmaps.yaml   # provisioning + dashboards, fed by --set-file
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
│   │       ├── provisioning/             # Grafana only reads these subdirectories
│   │       │   ├── datasources/
│   │       │   │   └── datasources.yml   # uid: prometheus
│   │       │   └── dashboards/
│   │       │       └── dashboards.yml
│   │       └── dashboards/
│   │           ├── fleet-dashboard.json
│   │           └── sut-dashboard.json
│   │
│   ├── okd/                              # OKD (CRC) Kustomize deploy, see infra/okd/README.md
│   │   ├── base/                         # routes.yaml (ui SSE timeout), control-api.yaml (chaos-results mount)
│   │   ├── overlays/crc/
│   │   └── scripts/                      # deploy.sh, create-secrets.sh, chaos-results.sh, ...
│   │
│   └── scripts/
│       ├── seed-db.sh
│       ├── load-queue-test.sh
│       └── chaos-kill-worker.sh
│
├── .gitlab-ci.yml                        # lint + test, UI build, helm lint
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

        