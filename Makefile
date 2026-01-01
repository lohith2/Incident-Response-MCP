.DEFAULT_GOAL := help

MCP_URL  ?= http://localhost:3000
WF_URL   ?= http://localhost:8000

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo "Incident Response MCP — available targets:"
	@echo ""
	@echo "  make dev              Start all services with docker compose (builds first)"
	@echo "  make build            Build all Docker images"
	@echo "  make logs             Tail logs from all services"
	@echo "  make test-tool        Smoke-test the alert_get_active MCP tool via HTTP"
	@echo "  make simulate-incident  Trigger a fake incident through the workflow"
	@echo "  make db-shell         Open a psql shell in the running Postgres container"
	@echo "  make redis-cli        Open redis-cli in the running Redis container"
	@echo "  make typecheck        Run tsc --noEmit on the TypeScript source"
	@echo "  make lint             Run eslint on the TypeScript source (if configured)"
	@echo "  make clean            Remove build artefacts and stop containers"

# ── Docker ────────────────────────────────────────────────────────────────────
.PHONY: dashboard-build
dashboard-build:
	cd dashboard && npm install && npm run build

.PHONY: dev
dev: dashboard-build
	docker compose up --build

.PHONY: build
build:
	docker compose build

.PHONY: logs
logs:
	docker compose logs -f

.PHONY: clean
clean:
	docker compose down -v
	rm -rf dist/ dashboard/dist/

# ── Testing ───────────────────────────────────────────────────────────────────
.PHONY: test-tool
test-tool:
	@echo "→ Calling alert_get_active on $(MCP_URL)"
	curl -s -X POST $(MCP_URL)/tools/call \
	  -H "Content-Type: application/json" \
	  -d '{"name":"alert_get_active","args":{"limit":5}}' \
	  | python3 -m json.tool

.PHONY: simulate-incident
simulate-incident:
	@echo "→ Triggering fake incident through workflow at $(WF_URL)"
	curl -s -X POST $(WF_URL)/trigger-workflow \
	  -H "Content-Type: application/json" \
	  -d '{"incident_id":"SIM-001","service":"payment-service","severity":"SEV2"}' \
	  | python3 -m json.tool

# ── Database / cache shells ───────────────────────────────────────────────────
.PHONY: db-shell
db-shell:
	docker compose exec postgres psql -U user -d incident_response

.PHONY: redis-cli
redis-cli:
	docker compose exec redis redis-cli

# ── TypeScript ────────────────────────────────────────────────────────────────
.PHONY: typecheck
typecheck:
	npx tsc --noEmit

.PHONY: lint
lint:
	npx eslint src/ --ext .ts
