.PHONY: up down build test run-worker run-fast run-slow run-cpu-heavy workers-up workers-scale workers-down \
        k8s-build k8s-load k8s-deploy k8s-status k8s-scale k8s-logs k8s-down helm-lint

# ── Infrastructure ──────────────────────────────────────────────────────────
up:
	docker compose up --build -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

# ── Tests ───────────────────────────────────────────────────────────────────
test-sut:
	cd services/sut && npm test

test-worker:
	cd services/worker && npm test

test: test-sut test-worker

# ── Phase 1: manual k6 runs ─────────────────────────────────────────────────
# Ensure SUT is up first: make up
run-worker:
	docker compose run --rm worker k6 run /app/scripts/k6/base-scenario.js

run-fast:
	docker compose run --rm \
	  -e VUS=$${VUS:-50} \
	  -e DURATION=$${DURATION:-60s} \
	  worker k6 run /app/scripts/k6/fast-endpoint.js

run-slow:
	docker compose run --rm \
	  -e VUS=$${VUS:-20} \
	  -e DURATION=$${DURATION:-60s} \
	  worker k6 run /app/scripts/k6/slow-endpoint.js

run-cpu-heavy:
	docker compose run --rm \
	  -e VUS=$${VUS:-5} \
	  -e DURATION=$${DURATION:-60s} \
	  worker k6 run /app/scripts/k6/cpu-heavy.js

# ── Phase 3: queue worker fleet ─────────────────────────────────────────────
workers-up:
	docker compose up -d worker

workers-scale:
	docker compose up -d --scale worker=$${N:-3} worker

workers-down:
	docker compose stop worker

# ── Phase 5: K8s / Helm ──────────────────────────────────────────────────────
# Prerequisites: kind cluster running, kubectl context = kind-loadtest
HELM_RELEASE ?= loadtest
HELM_CHART   := infra/k8s/helm
NAMESPACE    := loadtest-system
IMAGES       := loadtest/sut:latest loadtest/control-api:latest loadtest/worker:latest

k8s-build:
	docker build -t loadtest/sut:latest           services/sut
	docker build -t loadtest/control-api:latest   services/control-api
	docker build -t loadtest/worker:latest        services/worker

k8s-load: k8s-build
	@for img in $(IMAGES); do \
	  echo "Loading $$img into kind..."; \
	  kind load docker-image $$img --name loadtest; \
	done

helm-lint:
	helm lint $(HELM_CHART) -f $(HELM_CHART)/values.yaml \
	  --set secrets.jwtSecret=test --set secrets.apiKey=test \
	  --set secrets.postgresPassword=test

k8s-deploy: k8s-load
	kubectl apply -f infra/k8s/namespace.yaml
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
	  --namespace $(NAMESPACE) \
	  -f $(HELM_CHART)/values.yaml \
	  -f $(HELM_CHART)/values-local.yaml \
	  --set secrets.jwtSecret=$${JWT_SECRET} \
	  --set secrets.apiKey=$${API_KEY} \
	  --set secrets.postgresPassword=$${POSTGRES_PASSWORD:-changeme} \
	  --wait --timeout 120s

k8s-status:
	kubectl -n $(NAMESPACE) get pods,svc,deployments

k8s-scale:
	kubectl -n $(NAMESPACE) scale deployment/worker --replicas=$${N:-3}

k8s-logs:
	kubectl -n $(NAMESPACE) logs -l app=$${SVC:-worker} -f --tail=50

k8s-down:
	helm uninstall $(HELM_RELEASE) --namespace $(NAMESPACE) || true
	kubectl delete namespace $(NAMESPACE) --ignore-not-found

# ── Phase 6: KEDA autoscaling + chaos tests ──────────────────────────────────
.PHONY: keda-install keda-apply load-queue chaos-kill

keda-install:
	helm repo add kedacore https://kedacore.github.io/charts
	helm repo update
	helm upgrade --install keda kedacore/keda \
	  --namespace keda --create-namespace \
	  --version 2.14.0 \
	  --wait --timeout 120s

keda-apply:
	kubectl apply -f infra/k8s/keda/trigger-auth-redis.yaml
	kubectl apply -f infra/k8s/keda/scaledobject-worker.yaml
	@echo "KEDA ScaledObject applied — queue length drives worker replicas"
	@kubectl -n $(NAMESPACE) get scaledobject worker-scaledobject

# Push N jobs → watch scale-up → wait → watch scale-down
# Requires: API_KEY set, kubectl context pointing at $(NAMESPACE)
load-queue:
	NAMESPACE=$(NAMESPACE) bash infra/scripts/load-queue-test.sh $${N:-5} $${VUS:-10} $${DURATION:-30s}

# Kill a worker mid-job, verify job requeues
chaos-kill:
	NAMESPACE=$(NAMESPACE) bash infra/scripts/chaos-kill-worker.sh

seed-db:
	NAMESPACE=$(NAMESPACE) bash infra/scripts/seed-db.sh

# ── Phase 7: UI ───────────────────────────────────────────────────────────────
.PHONY: ui-dev ui-build

ui-dev:
	cd services/ui && npm install && npm run dev

ui-build:
	cd services/ui && npm install && npm run build
