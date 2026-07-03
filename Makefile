.PHONY: up down build test run-worker run-fast run-slow run-cpu-heavy workers-up workers-scale workers-down

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
