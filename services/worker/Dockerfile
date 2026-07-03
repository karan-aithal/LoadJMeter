# syntax=docker/dockerfile:1
# Phase 3: queue-driven worker (Node control loop + k6 binary).

# Pull k6 binary from official image.
FROM grafana/k6:0.51.0 AS k6

# Node runtime for queue consumption and orchestration.
FROM node:20.11.0-alpine3.19

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY --from=k6 /usr/bin/k6 /usr/bin/k6

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

CMD ["node", "src/index.js"]
