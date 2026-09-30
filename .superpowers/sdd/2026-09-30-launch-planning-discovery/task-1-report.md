# Task 1 Report: Planning Contracts and Configuration

## Summary

Added a provider-independent `PlanningInput` type and validator, preserving repository evidence order and allowing empty evidence/decision/task lists. Added optional `planning.profile` configuration, validating it as a non-empty reference to a configured agent profile. Configurations without `planning` retain their prior normalized shape.

## Files changed

- `packages/core/src/domain/planning-input.ts` (new)
- `packages/core/src/domain/index.ts`
- `packages/core/src/domain/project-config.ts`
- `packages/core/test/planning-input.test.ts` (new)
- `packages/core/test/project-config.test.ts`
- `packages/config/test/project-config-file.test.ts`

## TDD evidence

- **RED:** Ran `pnpm --filter @agentic-dev-runner/core exec vitest run test/planning-input.test.ts test/project-config.test.ts`. New contract tests failed because `validatePlanningInput` was unavailable; planner config test failed because `planning` was rejected. Existing core config cases passed.
- **GREEN:** Implemented the contract/config parser and reran focused core and config tests successfully.

## Verification

- Core package tests: 16 files, 236 tests passed.
- Config package tests: 1 file, 21 tests passed.
- Focused core tests: 2 files, 30 tests passed.
- Focused config test: 1 file, 21 tests passed.
- Core typecheck: passed.
- Config typecheck: passed.
- ESLint on changed source and test files: passed.
- `git diff --check`: passed.

## Concerns and deviations

- `packages/core/src/domain/agent-profile.ts` was not changed: Task 1's interfaces do not require a profile-domain change, and planning profile references reuse existing `AgentProfile.id` values.
- No architecture or V0.1 scope deviations.
