# syntax=docker/dockerfile:1
# Pin digest: run `docker pull node:20.11.0-alpine3.19` then
# replace tag with sha256 digest for production hardening.

# ---- deps stage ----
FROM node:20.11.0-alpine3.19 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- final stage ----
FROM node:20.11.0-alpine3.19 AS final
WORKDIR /app

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src ./src
COPY --chown=appuser:appgroup package.json ./

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "src/index.js"]
