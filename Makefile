# Guardian Pipeline — top-level `make verify` target
#
# A fresh clone should be able to `make install && make verify` and reproduce
# every gate enforced in CI. If a reviewer cannot reproduce the AMC score and
# the green checks from this file, the grade is theatrical.
#
# Sprint 1 wires the existing Foundry + guardian + assurance + dashboard
# chain. Later sprints add Echidna (sprint 2), Halmos (sprint 3), Slither /
# Aderyn (sprint 3), and the live-uptime + external-audit components into the
# AMC score (sprint 6). The future-stub targets below are intentionally
# present so the verify graph is stable across sprints — they print a
# "not-yet-wired" notice and exit 0 until their sprint lands.

.DEFAULT_GOAL := help
SHELL := /bin/bash

# --- top-level orchestration -------------------------------------------------

.PHONY: help install verify build test clean demo-addresses

demo-addresses: ## Print public Base Sepolia demo contract addresses (--verify checks chain)
	node scripts/lookup-demo-addresses.mjs --verify

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_.-]+:.*?## / {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: guardian-install assurance-install dashboard-install ## Install all subproject dependencies

verify: build test forge-test halmos echidna slither aderyn assurance-report ## Full reproducibility chain — `make verify` on a fresh clone must be green
	@echo
	@echo "=== verify complete — see AMC score above ==="

build: forge-build guardian-build assurance-build dashboard-build ## Build every subproject

test: guardian-test assurance-test ## Run TypeScript test suites

clean: ## Remove build artefacts
	forge clean
	rm -rf guardian/dist assurance/dist dashboard/dist

# --- Foundry / Solidity ------------------------------------------------------

.PHONY: forge-build forge-test forge-coverage

forge-build: ## Compile contracts
	forge build

forge-test: ## Run Foundry tests (unit, invariant fuzz, exploit replays)
	forge test

forge-coverage: ## Generate coverage report consumed by the assurance CLI
	forge coverage --report summary

# --- Exploit-replay catalogue ------------------------------------------------

.PHONY: exploit-summary

exploit-summary: ## Regenerate assurance/data/exploit-replays.json and patch README + docs/assurance.md marker blocks
	forge script script/ExploitReplay.s.sol
	cd assurance && npm run trace -- --update-exploit-docs

# --- Guardian bot ------------------------------------------------------------

.PHONY: guardian-install guardian-build guardian-test guardian-typecheck

guardian-install:
	cd guardian && npm install

guardian-typecheck:
	cd guardian && npm run typecheck

guardian-build: guardian-typecheck ## Build the off-chain monitor
	cd guardian && npm run build

guardian-test: ## Run guardian test suite (health checks + evaluator props)
	cd guardian && npm test

# --- Assurance CLI -----------------------------------------------------------

.PHONY: assurance-install assurance-build assurance-test assurance-report

assurance-install:
	cd assurance && npm install

assurance-build:
	cd assurance && npm run typecheck

assurance-test:
	cd assurance && npm test

assurance-report: ## Recompute the AMC score and write assurance-report.{json,md}
	cd assurance && npm run report

# --- Dashboard ---------------------------------------------------------------

.PHONY: dashboard-install dashboard-build

dashboard-install:
	cd dashboard && npm install

dashboard-build: ## Type-check and bundle the dashboard for production
	cd dashboard && npm run build

# --- External-signal stubs (wired in later sprints) --------------------------
# These are no-ops today so the `verify` target graph is stable. Each one
# becomes load-bearing in its sprint; until then the message documents what
# future-verify will enforce.

.PHONY: halmos echidna slither aderyn

halmos: ## [sprint 3] Symbolic proofs for INV-01, INV-06, INV-10
	@if command -v halmos >/dev/null 2>&1; then \
		forge test --match-contract Halmos --ffi ; \
	else \
		echo "[halmos] not yet wired — install halmos (sprint 3)"; \
	fi

echidna: ## Independent fuzz campaign cross-checking Foundry
	@if command -v echidna >/dev/null 2>&1; then \
		echidna . --contract EchidnaVault --config echidna.yaml ; \
	else \
		echo "[echidna] binary not installed locally — skipping. Install:"; \
		echo "  brew install echidna   # macOS"; \
		echo "  https://github.com/crytic/echidna#installation"; \
		echo "  CI uses the Trail of Bits docker image."; \
	fi

slither: ## Static analysis (non-gating; artifacts uploaded in CI)
	@if command -v slither >/dev/null 2>&1; then \
		slither . --config-file slither.config.json --fail-none ; \
	else \
		echo "[slither] binary not installed — CI uploads artifacts from invariant-ci"; \
	fi

aderyn: ## Static analysis (non-gating; artifacts uploaded in CI)
	@if command -v aderyn >/dev/null 2>&1; then \
		aderyn ; \
	else \
		echo "[aderyn] binary not installed — CI uploads artifacts from invariant-ci"; \
	fi
