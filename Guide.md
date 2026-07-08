# Required tools
node --version   # ≥ 20
docker --version
docker compose --version
# Optional (for K8s phases)
kind version; kubectl version --client; helm version

Unit tests (automated):
cd services/sut
npm test
# Expected: 8 passed

Manual smoke:
docker compose up sut --build -d
curl http://localhost:3000/healthz          # {"status":"alive"}
curl http://localhost:3000/readyz           # {"status":"ready"}
curl http://localhost:3000/fast             # {"endpoint":"fast","traceId":"..."}
curl http://localhost:3000/slow             # takes ~200ms
curl http://localhost:3000/cpu-heavy        # {"endpoint":"cpu-heavy","result":"..."}
curl -s http://localhost:3000/metrics | grep http_requests_total
# Expected: counter line for http_requests_total

curl -H "x-trace-id: my-test-id" http://localhost:3000/fast
# Response header x-trace-id must equal my-test-id

cd services/worker
npm test
# Expected: 4 passed (parseK6Result: PASS/FAIL/INCONCLUSIVE/saturation)

docker compose up sut --build -d
docker compose run --rm \
  -e VUS=5 -e DURATION=20s -e RAMP_UP=5s -e RAMP_DOWN=5s \
  worker k6 run /app/scripts/k6/base-scenario.js
# Expected:
#   ✓ fast 200 / slow 200 / cpu-heavy 200
#   PASS — all thresholds met, exit code 0

docker compose run --rm \
  -e VUS=5 -e DURATION=5s -e SUT_URL=http://nonexistent:9999 \
  worker k6 run /app/scripts/k6/base-scenario.js
# Expected: exit code 1 (error rate threshold breached)

cd services/control-api
npm test
# Expected: 20 passed

# From repo root
docker compose up sut postgres redis control-api --build -d
sleep 5

# Get token
TOKEN=$(curl -sf -X POST http://localhost:4000/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"'$API_KEY'"}' | jq -r .token)
echo $TOKEN   # should be a long JWT string

# POST test (with idempotency key)
curl -sf -X POST http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-001" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":5,"duration":"10s"}' | jq .
# Expected: {"id":"<uuid>","status":"pending",...}

# Same key again → idempotent return (HTTP 200, same id)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-001" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":5,"duration":"10s"}'
# Expected: 200

# Validation guardrail
curl -s -X POST http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-bad" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":9999,"duration":"10s"}' | jq .error
# Expected: "Validation failed"

# Swagger UI
open http://localhost:4000/api-docs   # or browse manually

docker compose exec redis redis-cli llen jobs:pending
# Expected: ≥ 1 (the job we just created)

docker compose up --build -d
sleep 10

# Watch worker pick up jobs
docker compose logs -f worker
# Expected: "job picked" → "job completed"

docker compose up --build -d
sleep 10

# Watch worker pick up jobs
docker compose logs -f worker
# Expected: "job picked" → "job completed"

docker compose up -d --scale worker=3 worker

# Push 3 jobs with different idempotency keys
for i in 1 2 3; do
  curl -sf -X POST http://localhost:4000/tests \
    -H "Authorization: Bearer $TOKEN" \
    -H "Idempotency-Key: scale-test-$i" \
    -H 'Content-Type: application/json' \
    -d '{"scenario":"fast","vus":3,"duration":"15s"}' | jq -r .id
done

# Verify 3 different workers handled them (worker_id in each run)
curl -s http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" | jq '.items[0:3] | .[].worker_id'
# Expected: 3 distinct worker IDs


Dead-letter / crash recovery:
# Push a job then immediately kill the worker
JOB_ID=$(curl -sf -X POST http://localhost:4000/tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: chaos-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"fast","vus":2,"duration":"60s"}' | jq -r .id)

sleep 3   # let worker pick it up
docker compose kill worker

# After restart, job must be requeued
sleep 5
docker compose exec redis redis-cli llen jobs:pending   # ≥ 1
docker compose up -d worker                             # worker restarts and picks up


Prometheus scraping SUT:
# After docker compose up
curl -s 'http://localhost:9090/api/v1/query?query=http_requests_total' | jq .status
# Expected: "success"

# Check worker metrics (must have run at least one job)
curl -s 'http://localhost:9090/api/v1/query?query=worker_jobs_total' | jq .status
# Expected: "success"

curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].name'
# Expected: "sut-slos", "fleet"


Grafana dashboards provisioned:
# Browse to http://localhost:3001 (admin/admin)
# Dashboards → LoadTest folder → "LoadTest SUT (RED)" + "LoadTest Fleet (USE)"
# Run a short test, verify panels update within 15s

# Set env var override to simulate saturation
docker compose run --rm \
  -e FLEET_CPU_SAT_THRESHOLD=0.0 \  # threshold 0% → always saturated
  -e VUS=2 -e DURATION=10s \
  worker node src/index.js
# A failing job should report verdict=INCONCLUSIVE


kind create cluster --name loadtest
kubectl cluster-info --context kind-loadtest

make k8s-load   # builds images + loads into kind
make k8s-deploy \
  JWT_SECRET=$(openssl rand -hex 32) \
  API_KEY=my-test-key \
  POSTGRES_PASSWORD=changeme


Verify all pods running:
kubectl -n loadtest-system get pods
# Expected: all pods Running/Ready
# sut, control-api, worker, postgres, redis, prometheus, grafana, alertmanager

kubectl -n loadtest-system get svc
# Expected: all services present

# Check NetworkPolicy applied
kubectl -n loadtest-system get networkpolicy

# Check resource limits set
kubectl -n loadtest-system describe deployment worker | grep -A5 Limits


Manual scale test:
kubectl -n loadtest-system scale deployment/worker --replicas=3
kubectl -n loadtest-system get pods -l app=worker   # 3 Running

# Port-forward and fire a job
kubectl -n loadtest-system port-forward svc/control-api 4000:4000 &
curl -X POST http://localhost:4000/auth/token \
  -d '{"apiKey":"my-test-key"}' -H 'Content-Type: application/json'

  Phase 6 — KEDA
make keda-install
make keda-apply

kubectl -n loadtest-system get scaledobject
# Expected: worker-scaledobject  READY=True  ACTIVE=...

# Load queue and watch scale-up
make load-queue N=5
# Watch: worker count increases from 1 → up to 5

# After jobs drain (~2 min):
kubectl -n loadtest-system get pods -l app=worker
# Expected: back to 1 replica (minReplicaCount)

# Chaos test
make chaos-kill
# Expected output: "jobs:pending=N" or "jobs:dead-letter=N"
# and replacement pod comes back up within 60s

Phase 7 — UI
docker compose up --build -d
open http://localhost:5173

Manual walkthrough checklist:

Login screen → enter API_KEY → should redirect to Dashboard
Launch a test: fill form (scenario=fast, VUs=5, duration=30s) → click Launch
Live status panel appears → watch status change pending → running → completed
Verdict badge visible (PASS / FAIL / INCONCLUSIVE)
History table shows the run with clickable "View"
Test detail page: full metadata + verdict front-and-center
Cancel button: launch a long test (duration=5m), then cancel → status=cancelled
Grafana iframe panels load below the history table (requires Grafana running)

cd services/ui
npm run build
# Expected: ✓ 42 modules transformed, exit 0