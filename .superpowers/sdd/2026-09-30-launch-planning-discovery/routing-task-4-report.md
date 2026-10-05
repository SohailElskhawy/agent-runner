# Cheap-First Routing Task 4 Report

- `agentic inspect` now renders each `task.routing.decided` event in sequence order with selected profile/tier, minimum tier, attempt count, and floor reason.
- Malformed or legacy payloads render a safe `details unavailable` line and do not interrupt inspection.
- README documents the optional tier field, omitted-tier compatibility, tier floor rules, failure-only escalation, and the existing `limits.max_attempts` cap.
- Red check: the new valid-routing inspect assertion failed before rendering support was added.
- Green verification: `pnpm --filter @agentic-dev-runner/cli exec vitest run test/run-cli.test.ts` (18 passed); `git diff --check`.
- CLI typecheck was run and is blocked by unrelated existing errors in `packages/cli/test/plan-approval.test.ts`: unused `writeFile`, an incorrect `RunnerStore` import from core, and calls to missing `RunnerAppService.approvePlan`.
