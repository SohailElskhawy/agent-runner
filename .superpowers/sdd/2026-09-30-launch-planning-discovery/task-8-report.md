# Task 8 implementation report

## Summary

Added a small TODO app E2E through the real CLI and existing scheduler lifecycle. The fixture agent first asks where TODO items persist, then returns two dependent tasks after the answer. The test confirms planning does not import tasks, explicit approval imports both, and `run` executes, verifies, and integrates both to `DONE`.

Planning and analysis now initialize the lazy SQLite store through startup reconciliation before listing tasks. The test also commits generated planning metadata before execution so Git integration begins from a clean project worktree.

## Files changed

- `packages/cli/test/planned-task-execution-e2e.test.ts`
- `packages/cli/test/fixtures/fake-opencode-dag-agent.mjs`
- `packages/cli/src/application/store-backed-app-service.ts`
- `packages/cli/test/planning-cli.test.ts`
- `docs/superpowers/plans/2026-09-30-launch-planning-discovery.md`

## Verification

- RED: initial E2E failed because planning attempted to list tasks while the lazy SQLite store was closed.
- GREEN: `pnpm --filter @agentic-dev-runner/cli exec vitest run test/planned-task-execution-e2e.test.ts test/multi-task-dag-e2e.test.ts` — 2 files, 2 tests passed.
- GREEN: `pnpm --filter @agentic-dev-runner/cli exec vitest run test/plan-approval.test.ts test/planning-cli.test.ts test/cli-end-to-end.test.ts` — 3 files, 24 tests passed.
- GREEN: `pnpm --filter @agentic-dev-runner/cli typecheck`.
- GREEN: `node --check packages/cli/test/fixtures/fake-opencode-dag-agent.mjs`.

## Architecture and unresolved issues

The test uses the same `runCli`, planner/application services, scheduler, verification, and Git integration wiring as the CLI; it adds no alternate scheduler or planner execution path. No persistence schema or dependencies changed. No unresolved Task 8 issues.
