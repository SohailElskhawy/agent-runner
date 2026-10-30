# Changelog

## Unreleased — v0.1 Technical Preview / Early Access

The v0.1.0 package version is prepared in source. Public publication and the
launch verification gates are still pending; this entry is not a release
announcement.

### Added
- `agentic inspect <task-id> --usage` displays per-attempt usage coverage, counter subtotals and separate exact reported amounts; provider parsers are not yet supported. Project planning, VERIFY and INTEGRATE are excluded; workflow PLAN is included. Default inspect output is unchanged.
- Provisional D-AP-8 per-attempt inspection read model derives conservative invocation coverage and independently checked token subtotals; exact reported costs remain separate evidence. Project planning, VERIFY and INTEGRATE are excluded, while workflow PLAN is included. Default CLI output is unchanged.
- Provisional D-AP-8 / ADR-020: SQLite v13 adds a nullable durable attempt execution mode, recorded before single-task invocation or workflow stages; legacy rows remain unknown without backfill. Omission preserves mode and conflicting or malformed modes are rejected atomically. Single-task result logs and optional invocation usage are saved together for success, failure, timeout and cancellation, and recovery preserves evidence. Missing results remain absent; legacy numeric usage and cost are unchanged. Older runners reject v13 and there is no downgrade path. No provider parsing, usage totals or display is added.
- Workflow PLAN, PLAN_REVIEW, IMPLEMENT and CODE_REVIEW stage runs now persist any neutral usage observation returned by their agent invocation, including failures and distinct review cycles. Missing results remain without evidence; provider parsing, totals and display remain separate work.
- Neutral invocation usage observation contract (D-AP-6 slice 1, per ADR-020): provider-reported per-invocation usage evidence types with unknown/partial/complete/inconsistent status, distinct optional counters, exact reported cost with currency and provenance, and strict safe validation. That slice added only the contract; provider parsing and display remain separate work.
- Additive SQLite migration v12 (D-AP-6 slice 2a, per ADR-020): nullable `stage_runs.usage_json` and `attempts.invocation_usage_json` persist one validated, versioned invocation usage observation per stage run / single-task attempt. Writes validate with the core contract and reject malformed, contradictory or unsupported-version observations before any SQL runs; reads fail explicitly on stored evidence that no longer validates and never repair it. A put that omits an observation keeps already-stored evidence, and rows written before the migration load unchanged with no usage (unknown, never zero). That slice added persistence only; provider parsing, totals and display remain separate work, and legacy `tokenUsage`/`cost` stay unverified. Opening a v12 database with an older runner is rejected by the existing newer-schema check; no downgrade path.
- Packed-install smoke coverage for durable pause/resume and paused execution refusal using separate CLI processes and a fake provider.
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
- Invocation usage evidence is immutable after its first non-null observation for a stage run or attempt: conflicting replacements fail atomically without changing the row, while omission and semantically identical replay remain allowed (provisional ADR-020 policy A).
- Invocation usage observation validation rejects unknown keys on `cost` and `cost.provenance` (per ADR-020 strict-shape contract) instead of silently stripping estimated/derived/unknown metadata; such evidence is now safely rejected rather than passing through as plain provider-reported cost.
- Cold-start README/CONTRIBUTING walkthrough fixes from a verified stranger walkthrough: Node.js >= 25 removed `corepack` from the Node distribution, so the documented install commands include the direct-`pnpm` fallback; the quickstart model id is called out as subscription-specific (`opencode models`); the manual `tasks add` path now documents that execution requires a clean working tree (uncommitted task files make integration fail with "integration worktree has uncommitted changes") and how failed attempts escalate the routing tier when no profile qualifies.
- OpenCode adapter read-only planning works on opencode CLI 2.x again (2.x failure modes reproduced and diagnosed live on 2.2.0; `--standalone` invocation shape provisional per AR048): the adapter detects the CLI major version once per adapter and, for read-only planning invocations on 2.x, drops the removed `--pure` flag and runs with `--standalone` so the agent injected through `OPENCODE_CONFIG` is resolved by the private server; 1.x keeps the exact previous `--pure` invocation, and undetectable versions fall back to that legacy contract. The injected read-only agent contract (edit/bash/task/skill denied) is unchanged on both versions (per provisional ADR-021); fixture tests emulate the live 2.x failures as regression guards.
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
