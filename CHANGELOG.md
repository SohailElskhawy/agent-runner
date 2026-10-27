# Changelog

## Unreleased — v0.1 Technical Preview / Early Access

The v0.1.0 package version is prepared in source. Public publication and the
launch verification gates are still pending; this entry is not a release
announcement.

### Added
- Unified workflow execution for single-task and unattended runs, with integration verification before DONE.
- `agentic approve` and `agentic retry` with durable, bounded state.
- `agentic tasks` listing and `agentic doctor` preflight checks.
- Publishable `agentic-dev-runner` npm package (bundled CLI, Node >= 24).
- CI matrix for Linux, macOS, and Windows; 20-task roadmap e2e; forced-kill recovery e2e; provider-failure and parallel-stress coverage.
- Bounded repository analysis, decision-file discovery, validated plan drafts, explicit plan approval, and deterministic cheap-first profile routing.

### Fixed
- CI and the documented verification workflow now run `pnpm build` before `pnpm typecheck`; a clean checkout previously failed typecheck with TS2307 because package exports reference the generated `dist` output.
- Corrected Codex context cleanup tests to inspect artifacts in the task worktree.

### Deferred to v0.2
- Token/cost analytics (`cost`), `pause/resume`, structured logging, automatic alternate-provider fallback, learned routing, and dynamic context relevance discovery.
