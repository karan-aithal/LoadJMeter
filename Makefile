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
.PHONY: keda-install keda-apply load-queue bench-backlog chaos-kill

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
	NAMESPACE=$(NAMESPACE) bash infra/scripts/load-queue-test.sh $${N:-6} $${VUS:-10} $${DURATION:-30s}

# Sustained backlog: N jobs at once, sample fleet CPU/throughput until drained
bench-backlog:
	NAMESPACE=$(NAMESPACE) bash infra/scripts/load-backlog-bench.sh $${N:-30} $${VUS:-10} $${DURATION:-30s}

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

# ── OKD (CRC okd preset) + external TLS PostgreSQL ───────────────────────────
# See infra/okd/README.md. The chaos script calls kubectl, so a kubectl->oc shim dir goes on PATH.
.PHONY: okd-prereqs okd-tools okd-tls okd-secrets okd-build okd-deploy okd-smoke okd-chaos okd-down \
        okd-keda-install okd-keda-apply okd-keda-down

okd-prereqs:
	bash infra/okd/scripts/cluster-prereqs.sh

okd-tools:
	bash infra/okd/scripts/install-tools.sh

okd-tls:
	bash infra/okd/postgres-tls/gen-certs.sh

okd-secrets:
	bash infra/okd/scripts/create-secrets.sh

okd-build:
	bash infra/okd/scripts/build-images.sh

okd-deploy:
	bash infra/okd/scripts/deploy.sh

okd-smoke:
	bash infra/okd/scripts/smoke.sh

okd-chaos:
	@mkdir -p .okd-shim && ln -sf "$$(command -v oc)" .okd-shim/kubectl
	PATH="$(CURDIR)/.okd-shim:$$PATH" NAMESPACE=loadtest-system bash infra/scripts/chaos-kill-worker.sh

okd-down:
	oc delete project loadtest-system

# Optional KEDA add-on for OKD (not part of okd-deploy; see infra/okd/README.md). `keda-install` is the kind/Helm path.
okd-keda-install:
	helm repo add kedacore https://kedacore.github.io/charts
	helm repo update
	helm upgrade --install keda kedacore/keda --namespace keda --create-namespace \
	  --version 2.14.0 -f infra/okd/keda-values.yaml --wait --timeout 180s

okd-keda-apply:
	kubectl apply -f infra/okd/keda-networkpolicy.yaml -f infra/k8s/keda/trigger-auth-redis.yaml -f infra/k8s/keda/scaledobject-worker.yaml

okd-keda-down:
	kubectl delete -f infra/k8s/keda/scaledobject-worker.yaml -f infra/k8s/keda/trigger-auth-redis.yaml -f infra/okd/keda-networkpolicy.yaml --ignore-not-found
	helm uninstall keda --namespace keda
