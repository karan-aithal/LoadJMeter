# LoadJMeter
Distributed Load Testing Platform


cp .env.example .env
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


kind create cluster --name loadtest
JWT_SECRET=$(openssl rand -hex 32) API_KEY=$(openssl rand -hex 16) make k8s-deploy
make k8s-status
make k8s-scale N=3
kubectl -n loadtest-system logs -l app=worker -f