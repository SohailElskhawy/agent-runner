# Changelog

## 0.1.0 — 2026-09-24

Initial open-source release.

### Added
- Unified workflow execution for single-task and unattended runs, with integration verification before DONE.
- `agentic approve` and `agentic retry` with durable, bounded state.
- `agentic tasks` listing and `agentic doctor` preflight checks.
- Publishable `agentic-dev-runner` npm package (bundled CLI, Node >= 24).
- CI matrix for Linux, macOS, and Windows; 20-task roadmap e2e; forced-kill recovery e2e; provider-failure and parallel-stress coverage.

### Deferred to v0.2
- Autonomous discovery/planning (`analyze`, `plan`, task generation), token/cost telemetry (`cost`), `pause/resume`, structured logging, agent fallback/escalation, and context relevance discovery.
