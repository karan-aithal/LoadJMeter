# syntax=docker/dockerfile:1

# ---- build ----
FROM node:20.11.0-alpine3.19 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---- serve (nginx static) ----
# unprivileged: runs as arbitrary non-root UID (OpenShift restricted-v2), listens on 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine AS final
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/index.html || exit 1
CMD ["nginx", "-g", "daemon off;"]
