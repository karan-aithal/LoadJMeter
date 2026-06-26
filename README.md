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