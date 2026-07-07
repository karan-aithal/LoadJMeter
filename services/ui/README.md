# UI

React SPA dashboard for the load test platform.

## Features

- Login with API key ? JWT session (sessionStorage)
- Launch test form with client-side validation (VUs 1–500, duration regex)
- Live status polling every 3s with animated progress bar
- PASS / FAIL / INCONCLUSIVE verdict badge — front and center
- Paginated test history table with cancel button
- Embedded Grafana panels (SUT RED + Fleet saturation)
- Test detail page with full metadata

## Run locally (dev)

```bash
cd services/ui
npm install
VITE_API_URL=http://localhost:4000 npm run dev
# Open http://localhost:5173
# Login with your API_KEY
```

## Docker (production build via nginx)

```bash
docker build -t loadtest/ui:latest .
docker run -p 5173:80 loadtest/ui:latest
```

## Environment Variables (build-time)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:4000` | Control API URL (dev proxy) |
| `VITE_GRAFANA_URL` | `http://localhost:3001` | Grafana base URL for iframe embeds |
| `VITE_PORT` | `5173` | Dev server port |
