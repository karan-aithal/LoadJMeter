# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:20.11.0-alpine3.19 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- final ----
FROM node:20.11.0-alpine3.19 AS final
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps       --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src        ./src
COPY --chown=appuser:appgroup migrations ./migrations
COPY --chown=appuser:appgroup package.json ./

USER appuser
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1

CMD ["node", "src/index.js"]
