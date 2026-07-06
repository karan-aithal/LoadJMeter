# Control API

Authenticated REST API for managing load test runs.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/token` | API key | Exchange API key for JWT |
| POST | `/tests` | JWT + Idempotency-Key | Create + enqueue test run |
| GET | `/tests` | JWT | Paginated test run list |
| GET | `/tests/:id` | JWT | Get test run by ID |
| DELETE | `/tests/:id` | JWT | Cancel test run |
| PATCH | `/tests/:id/status` | x-api-key | Worker status update (internal) |
| POST | `/tests/:id/heartbeat` | x-api-key | Worker heartbeat (internal) |
| GET | `/api-docs` | — | Swagger UI |

## Run locally

```bash
cd services/control-api
npm install
# Requires Postgres + Redis running (see root docker-compose.yml)
DATABASE_URL=postgresql://loadtest:changeme@localhost:5432/loadtest \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=changeme-min-32-chars \
API_KEY=changeme \
node src/index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (4000) | HTTP port |
| `DATABASE_URL` | Yes | Postgres connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_SECRET` | Yes | =32 chars, signs JWTs |
| `API_KEY` | Yes | Key for `POST /auth/token` + internal worker calls |
| `JWT_EXPIRES_IN` | No (24h) | JWT validity |
| `MAX_VUS` | No (500) | Max allowed VUs per test |
| `MAX_DURATION_S` | No (3600) | Max allowed test duration in seconds |
