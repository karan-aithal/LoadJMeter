# LoadJMeter
Distributed Load Testing Platform


cp .env.example .env
docker compose up --build
# SUT:        http://localhost:3000/metrics
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3001 (admin/admin)