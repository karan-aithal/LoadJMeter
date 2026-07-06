# SUT — System Under Test

Minimal Node.js/Express API that serves as the target for load tests.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/fast` | Instant JSON response |
| GET | `/slow` | Configurable delay (`SLOW_DELAY_MS`) |
| GET | `/cpu-heavy` | Fibonacci to `FIB_N` — CPU-bound |
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe |
| GET | `/metrics` | Prometheus metrics |

## Run locally

```bash
cd services/sut
npm install
node src/index.js          # or: npm run dev
```

## Docker

```bash
docker build -t loadtest/sut:latest .
docker run -p 3000:3000 loadtest/sut:latest
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `SLOW_DELAY_MS` | `200` | Artificial delay on `/slow` (ms) |
| `FIB_N` | `35` | Fibonacci n for `/cpu-heavy` |

## SLOs

See [../../docs/slo.md](../../docs/slo.md).
