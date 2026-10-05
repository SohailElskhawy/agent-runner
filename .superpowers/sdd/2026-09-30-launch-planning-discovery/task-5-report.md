# Task 5 implementation report

## Summary

Added file-backed decisions and deterministic draft plans, plus a bounded planner that invokes the configured agent in a detached worktree at the analyzed revision. Important unanswered questions are written to `.agentic/decisions.md`; answer IDs feed readiness, and a repeated discovery response after answers triggers another planner call for a ready plan. Valid plans are normalized before draft files are written. Planner edits to the isolated worktree are rejected; Codex uses its read-only sandbox and OpenCode uses a temporary external config with edit/bash/task/skill denied. Worktree and draft cleanup cover failed/partial creation while preserving complete edited drafts.

## Files changed

- `packages/cli/src/application/planning/plan-files.ts`
- `packages/cli/src/application/planning/planner.ts`
- `packages/cli/src/application/app-services.ts`
- `packages/cli/test/planning-files.test.ts`
- `packages/cli/test/planner.test.ts`
- `packages/agents/src/runtime/agent-runtime.ts`
- `packages/agents/src/adapters/codex/codex-adapter.ts`
- `packages/agents/src/adapters/opencode/opencode-adapter.ts`
- `packages/agents/test/codex-adapter.test.ts`
- `packages/agents/test/opencode-adapter.test.ts`
- `docs/superpowers/plans/2026-09-30-launch-planning-discovery.md`

## Verification

- RED: initial focused test run failed because both planned modules did not exist.
- RED regressions: worktree source-edit test failed before rejection was implemented; read-only boundary test failed before planner `readOnly` propagation; incomplete-draft test failed when only `plan.json` was checked.
- RED regression: a missing summary with an edited `plan.json` must preserve the edit; the test exposed the first repair implementation deleting it.
- RED regression: a missing `plan.json` with edited companion files exposed directory deletion; recovery now creates only missing files and preserves all existing companions and extra files.
- GREEN: CLI planning tests — `pnpm --filter @agentic-dev-runner/cli exec vitest run test/planning-files.test.ts test/planner.test.ts` — 2 files, 11 tests passed.
- GREEN: agent adapter tests — `pnpm --filter @agentic-dev-runner/agents exec vitest run test/codex-adapter.test.ts test/opencode-adapter.test.ts` — 2 files, 33 passed, 3 skipped.
- GREEN: `pnpm --filter @agentic-dev-runner/agents typecheck`.
- OpenCode config check: local OpenCode 1.18.33 loaded the generated external config via `OPENCODE_CONFIG`; `opencode debug agent <name> --pure` showed edit/bash/task/skill denied. Adapter test also verifies inherited `PATH`, selected agent, project config preservation, and temp config cleanup.
- `pnpm --filter @agentic-dev-runner/cli typecheck` — blocked by concurrent changes in `agent-routing.ts:122` (union narrowing), `ports.ts` (unused `PlanningQuestion`), and `store-backed-app-service.ts` (duplicate `validateManualTaskInput`). No reported failure is in Task 5 source files.

## Architecture and unresolved issues

`GitManager.createWorktree` always creates a named branch and cannot select a revision. To avoid persistent branch residue and guarantee the analyzed base, creation uses `ProcessRunner` with direct arguments to `git worktree add --detach <path> <baseRevision>`; cleanup uses `GitManager.removeWorktree(..., { force: true })` and removes a partial directory in `finally`. OpenCode's repository-local agent directory was avoided because an untrusted repo may make `.opencode/agents` a symlink: the adapter writes a unique JSON config under its external temporary context directory and passes its path through `OPENCODE_CONFIG`, inheriting defined environment variables. A complete plan draft is preserved on repeated generation; missing files are added without replacing any existing companion, including editable `plan.json`. The worktree is disposable and never integrated. The planner requires a committed base and asks for a fresh analysis if HEAD changed.

No database or production dependency was added. No CLI command wiring was changed. Full CLI typecheck remains pending the concurrent integration fixes.
