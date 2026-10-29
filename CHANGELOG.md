# Changelog

## Unreleased — v0.1 Technical Preview / Early Access

The v0.1.0 package version is prepared in source. Public publication and the
launch verification gates are still pending; this entry is not a release
announcement.

### Added
- V0.2 M075: durable CLI pause/resume, atomic control events and admission, and scheduler drain with startup recovery preserved. In-flight agents are not interrupted. Pause and resume require initialization; existing run-before-init behavior remains unchanged.
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
- Single-task orchestrator tests allow bounded time for Windows Git operations and await complete runs before closing the store and retrying fixture cleanup.
- Windows E2E fixtures compare canonical worktree paths and allow the 20-task Git workflow more time, waiting for the test run before cleanup.
- Default project state paths resolve directory aliases, including Windows short names, and missing descendants through their nearest existing ancestor; Windows and macOS case folding is preserved, and existing state is not migrated. Workflow executor tests await Git processes and retry cleanup on Windows.
- Cross-platform verification, agent, orchestrator, and Git test suites canonicalize temporary working directories, await in-flight Git child processes before Windows directory cleanup, and use a 300ms lease window in heartbeat renewal settlement tests.
- `writeDiscoveryQuestions` deduplicates repeated question IDs in first-seen order so preserved or generated decision blocks are not emitted twice in `.agentic/decisions.md`.
- Worktree detection resolves directory aliases (symlinks on macOS/Linux, junctions and Windows short names) using nearest-existing-ancestor path reconstruction when worktree directories are deleted, so registered and stale worktrees are found regardless of the path alias form used to register them.
- Platform tests compare the child's canonical working-directory path, which macOS reports as `/private/var/...` for `/var/...` temp directories.
- Discovery regeneration preserves the raw blocks of answered decisions, including multiline answers, CRLF, and `Question ID:` blocks, without accumulating blank lines.
- Repository analysis preserves legacy parsed heading IDs while retaining broader block IDs for future decision-file preservation.
- Repository analysis reads two-space-indented decision answer continuations, treats marker-like lines indented by at least two spaces within an answer as content, and stops planning when an answer remains open at the 65,536-byte read limit.
- Discovery writes decisions through a temporary file before replacement, preserving the original if writing or replacement fails.
- Repository analysis bounds each candidate file read and ignores incomplete decision lines at the read limit.
- CI and the documented verification workflow now run `pnpm build` before `pnpm typecheck`; a clean checkout previously failed typecheck with TS2307 because package exports reference the generated `dist` output.
- Discovery preserves existing decisions and reports read failures instead of treating them as a missing file.
- Corrected Codex context cleanup tests to inspect artifacts in the task worktree.

### Deferred to v0.2
- Token/cost analytics (`cost`), structured logging, automatic alternate-provider fallback, learned routing, and dynamic context relevance discovery.
