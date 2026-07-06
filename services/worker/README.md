# Worker

Queue-driven load test executor. Pulls jobs from Redis, runs k6, reports verdict to control-api.

## How it works

1. Polls `jobs:pending` Redis list (`BRPOPLPUSH` — atomic, no double-pickup)
2. Spawns `k6 run <script>` as child process
3. Sends heartbeat to control-api every `HEARTBEAT_INTERVAL_MS`
4. On k6 exit: determines PASS / FAIL / INCONCLUSIVE (fleet CPU > 80%)
5. On failure: retries up to `MAX_RETRIES`, then sends to `jobs:dead-letter`
6. On SIGTERM: finishes/aborts current run cleanly

## k6 Scripts

| Script | Scenario |
|--------|----------|
| `scripts/k6/base-scenario.js` | Mixed: fast + slow + cpu-heavy |
| `scripts/k6/fast-endpoint.js` | `/fast` only |
| `scripts/k6/slow-endpoint.js` | `/slow` only |
| `scripts/k6/cpu-heavy.js` | `/cpu-heavy` only |

## Run manually (Phase 1 style)

```bash
# Requires SUT running
docker compose run --rm worker k6 run /app/scripts/k6/fast-endpoint.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Queue source |
| `CONTROL_API_URL` | `http://control-api:4000` | Status/heartbeat target |
| `WORKER_API_KEY` | — | Same as `API_KEY` in control-api |
| `SUT_URL` | `http://sut:3000` | k6 target base URL |
| `WORKER_ID` | `worker-<pid>` | Identity for heartbeat |
| `HEARTBEAT_INTERVAL_MS` | `5000` | Heartbeat frequency |
| `MAX_RETRIES` | `3` | Retries before dead-letter |
| `WORKER_METRICS_PORT` | `9464` | Prometheus `/metrics` port |
| `K6_PROMETHEUS_RW_SERVER_URL` | — | If set, k6 pushes runtime metrics via remote-write |
