# Task 4 Report: Normalize Tasks and Validate the Plan DAG

## Summary

Added runner-owned defaults for planner tasks and whole-plan validation: strict manual task validation, task and milestone ID checks, milestone coverage, dependency resolution and cycle detection, configured verification checks, per-task size limits, and conflict reporting through the existing detector. Risk chooses `simple` for low, `default` for medium, and `security-critical` for high or critical tasks; high and critical tasks require approval.

## Files changed

- `packages/core/src/domain/planned-task.ts` (new)
- `packages/core/src/domain/plan-validation.ts` (new)
- `packages/core/src/domain/index.ts`
- `packages/core/test/plan-validation.test.ts` (new)

## TDD and review-fix evidence

- **RED:** Before implementation, all 5 focused tests failed because `normalizeAndValidatePlan` was not exported.
- **GREEN:** Focused plan validation passed (5 tests); existing task ingestion and conflict tests passed (36 tests); core typecheck passed.
- **Review RED:** Added tests for risk-to-workflow mapping and for retaining size/check diagnostics when another schema issue exists. The focused run failed in the two expected places: low risk still selected `default`, and schema failure suppressed independent diagnostics.
- **Review GREEN:** Updated risk mapping and made size/check diagnostics independent of base schema validation. Focused plan validation passed (7 tests).

## Verification

- `pnpm --filter @agentic-dev-runner/core exec vitest run test/plan-validation.test.ts test/task-ingestion.test.ts test/task-conflicts.test.ts` — passed (3 files, 43 tests).
- `pnpm --filter @agentic-dev-runner/core typecheck` — passed.
- `git diff --check` — passed.
- No changes staged or committed, per coordination request.

## Concerns and deviations

- None known. No Task 2 files were modified.
