SHELL := /bin/sh

NODE ?= node
NPM ?= npm
BINARY := tsray
ROOT ?= .

MCP_NAME ?= tsray
MCP_SCOPE ?= global
MCP_ARGS ?= serve
MCP_TARGET ?=
MCP_FORMAT ?=
MCP_CONFIG ?=
MCP_CWD ?=
MCP_BIN ?=
MCP_DRY_RUN ?=
MCP_YES ?=
OPENCODE_CONFIG ?=

SKILL_NAME ?= tsray
SKILL_SCOPE ?= global
SKILL_TARGET ?=
SKILL_DIR ?=
SKILL_MODE ?= copy
SKILL_DRY_RUN ?=
SKILL_YES ?=

.DEFAULT_GOAL := help

.PHONY: all build install uninstall install-mcp uninstall-mcp mcp-status install-skill uninstall-skill skill-status install-all uninstall-all test test-watch typecheck lint verify web-install web-dev web-typecheck web-build build-bin release-check release-snapshot tidy db-info clean help

all: build ## Build the CLI

build: ## Compile dist/ and make the CLI executable
	$(NPM) run build

install: build ## Link the CLI globally with npm link
	$(NPM) link
	@command -v $(BINARY) >/dev/null 2>&1 && echo "installed $$(command -v $(BINARY))"

uninstall: ## Remove the global npm link/install
	@if command -v $(BINARY) >/dev/null 2>&1; then \
		$(NPM) uninstall --global $(BINARY); \
	else \
		echo "not installed: $(BINARY)"; \
	fi

install-mcp: build ## Register the MCP server in selected clients
	@TSRAY_MCP_NAME="$(MCP_NAME)" \
	TSRAY_MCP_SCOPE="$(MCP_SCOPE)" \
	TSRAY_MCP_TARGET="$(MCP_TARGET)" \
	TSRAY_MCP_FORMAT="$(MCP_FORMAT)" \
	TSRAY_MCP_CONFIG="$(MCP_CONFIG)" \
	TSRAY_MCP_CWD="$(MCP_CWD)" \
	TSRAY_MCP_ARGS="$(MCP_ARGS)" \
	TSRAY_MCP_COMMAND="$(MCP_BIN)" \
	OPENCODE_CONFIG="$(OPENCODE_CONFIG)" \
	$(NODE) dist/cli/index.js install-mcp $(if $(MCP_DRY_RUN),--dry-run,) $(if $(MCP_YES),--yes,)

uninstall-mcp: build ## Remove the MCP server from selected clients
	@TSRAY_MCP_NAME="$(MCP_NAME)" \
	TSRAY_MCP_SCOPE="$(MCP_SCOPE)" \
	TSRAY_MCP_TARGET="$(MCP_TARGET)" \
	TSRAY_MCP_FORMAT="$(MCP_FORMAT)" \
	TSRAY_MCP_CONFIG="$(MCP_CONFIG)" \
	OPENCODE_CONFIG="$(OPENCODE_CONFIG)" \
	$(NODE) dist/cli/index.js uninstall-mcp $(if $(MCP_DRY_RUN),--dry-run,) $(if $(MCP_YES),--yes,)

mcp-status: build ## Show MCP registration status
	@TSRAY_MCP_NAME="$(MCP_NAME)" \
	TSRAY_MCP_SCOPE="$(MCP_SCOPE)" \
	TSRAY_MCP_TARGET="$(MCP_TARGET)" \
	TSRAY_MCP_FORMAT="$(MCP_FORMAT)" \
	TSRAY_MCP_CONFIG="$(MCP_CONFIG)" \
	OPENCODE_CONFIG="$(OPENCODE_CONFIG)" \
	$(NODE) dist/cli/index.js mcp-status $(if $(MCP_YES),--yes,)

install-skill: build ## Install the agent skill in selected clients
	@TSRAY_SKILL_NAME="$(SKILL_NAME)" \
	TSRAY_SKILL_SCOPE="$(SKILL_SCOPE)" \
	TSRAY_SKILL_TARGET="$(SKILL_TARGET)" \
	TSRAY_SKILL_DIR="$(SKILL_DIR)" \
	TSRAY_SKILL_MODE="$(SKILL_MODE)" \
	$(NODE) dist/cli/index.js install-skill $(if $(SKILL_DRY_RUN),--dry-run,) $(if $(SKILL_YES),--yes,)

uninstall-skill: build ## Remove the agent skill from selected clients
	@TSRAY_SKILL_NAME="$(SKILL_NAME)" \
	TSRAY_SKILL_SCOPE="$(SKILL_SCOPE)" \
	TSRAY_SKILL_TARGET="$(SKILL_TARGET)" \
	TSRAY_SKILL_DIR="$(SKILL_DIR)" \
	$(NODE) dist/cli/index.js uninstall-skill $(if $(SKILL_DRY_RUN),--dry-run,) $(if $(SKILL_YES),--yes,)

skill-status: build ## Show agent skill status
	@TSRAY_SKILL_NAME="$(SKILL_NAME)" \
	TSRAY_SKILL_SCOPE="$(SKILL_SCOPE)" \
	TSRAY_SKILL_TARGET="$(SKILL_TARGET)" \
	TSRAY_SKILL_DIR="$(SKILL_DIR)" \
	$(NODE) dist/cli/index.js skill-status $(if $(SKILL_YES),--yes,)

install-all: install install-skill install-mcp ## Install CLI, skill, and MCP registration

uninstall-all: uninstall-mcp uninstall-skill uninstall ## Remove MCP registration, skill, and CLI

test: ## Run unit tests
	$(NPM) test

test-watch: ## Run tests in watch mode
	$(NPM) run test:watch

typecheck: ## Typecheck source and tests
	$(NPM) run typecheck

lint: ## Run ESLint
	$(NPM) run lint

verify: lint typecheck test ## Run lint, typecheck, and tests

web-install: ## Install web dependencies from the committed lockfile
	cd web && $(NPM) ci

web-dev: ## Run the Vite dev server (proxies /api to tsray serve)
	cd web && $(NPM) run dev

web-typecheck: ## Typecheck the report frontend
	cd web && $(NPM) run typecheck

web-build: ## Build and embed the single-file report
	$(NPM) run build:web

build-bin: ## Compile an optional Bun standalone binary
	bun build ./src/cli/index.ts --compile --outfile ./bin/tsray

release-check: ## Validate the npm package contents
	$(NPM) run pack:check

release-snapshot: ## Build a local npm tarball without publishing
	$(NPM) pack

tidy: ## Refresh root and web dependencies
	$(NPM) install
	cd web && $(NPM) install

db-info: build ## Print populated cache statistics
	$(NODE) dist/cli/index.js db info "$(ROOT)"

clean: ## Remove compiled output
	rm -rf dist bin

help: ## Show available targets and variables
	@awk 'BEGIN {FS = ":.*## "; printf "tsray\n\nTargets:\n"} \
		/^[a-zA-Z0-9_.-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '\nVariables:\n'
	@printf '  ROOT=%s\n' '$(ROOT)'
	@printf '  MCP_NAME=%s       (MCP server key)\n' '$(MCP_NAME)'
	@printf '  MCP_SCOPE=%s      (global|project)\n' '$(MCP_SCOPE)'
	@printf '  MCP_TARGET=%s     (opencode|claude|codex|cursor|gemini|antigravity|agents|detected|installed|all or path)\n' '$(MCP_TARGET)'
	@printf '  MCP_CONFIG=%s     (explicit config file)\n' '$(MCP_CONFIG)'
	@printf '  MCP_FORMAT=%s     (opencode|claude|codex|cursor|gemini|antigravity|agents|generic)\n' '$(MCP_FORMAT)'
	@printf '  MCP_ARGS=%s       (server arguments; default: serve)\n' '$(MCP_ARGS)'
	@printf '  MCP_CWD=%s        (fixed working directory)\n' '$(MCP_CWD)'
	@printf '  MCP_BIN=%s        (executable override)\n' '$(MCP_BIN)'
	@printf '  MCP_DRY_RUN=%s    (set to preview without writing)\n' '$(MCP_DRY_RUN)'
	@printf '  SKILL_SCOPE=%s    (global|project)\n' '$(SKILL_SCOPE)'
	@printf '  SKILL_TARGET=%s   (opencode|claude|codex|cursor|gemini|agents|detected|installed|all or path)\n' '$(SKILL_TARGET)'
	@printf '  SKILL_DIR=%s      (explicit destination base)\n' '$(SKILL_DIR)'
	@printf '  SKILL_MODE=%s     (copy|link)\n' '$(SKILL_MODE)'
