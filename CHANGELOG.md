# Changelog

## Unreleased — v0.1 Technical Preview / Early Access

The v0.1.0 package version is prepared in source. Public publication and the
launch verification gates are still pending; this entry is not a release
announcement.

### Added
- Dated release-gate evidence snapshot (2026-10-28) with explicit claim limits in the launch roadmap, linked from the release and dogfood docs.
- Recorded OpenCode JSONL log-report example with isolated state, immutable acceptance tests, real execution transcripts and verified final output.
- Run the existing CI matrix on pushes to `autopilot/main`.
- Unified workflow execution for single-task and unattended runs, with integration verification before DONE.
- `agentic approve` and `agentic retry` with durable, bounded state.
- `agentic tasks` listing and `agentic doctor` preflight checks.
- Publishable `agentic-dev-runner` npm package (bundled CLI, Node >= 24).
- CI matrix for Linux, macOS, and Windows; 20-task roadmap e2e; forced-kill recovery e2e; provider-failure and parallel-stress coverage.
- Bounded repository analysis, decision-file discovery, validated plan drafts, explicit plan approval, and deterministic cheap-first profile routing.

### Fixed
- Repository analysis preserves legacy parsed heading IDs while retaining broader block IDs for future decision-file preservation.
- Repository analysis reads two-space-indented decision answer continuations, treats marker-like lines indented by at least two spaces within an answer as content, and stops planning when an answer remains open at the 65,536-byte read limit.
- Discovery writes decisions through a temporary file before replacement, preserving the original if writing or replacement fails.
- Repository analysis bounds each candidate file read and ignores incomplete decision lines at the read limit.
- CI and the documented verification workflow now run `pnpm build` before `pnpm typecheck`; a clean checkout previously failed typecheck with TS2307 because package exports reference the generated `dist` output.
- Discovery preserves existing decisions and reports read failures instead of treating them as a missing file.
- Corrected Codex context cleanup tests to inspect artifacts in the task worktree.

### Deferred to v0.2
- Token/cost analytics (`cost`), `pause/resume`, structured logging, automatic alternate-provider fallback, learned routing, and dynamic context relevance discovery.
