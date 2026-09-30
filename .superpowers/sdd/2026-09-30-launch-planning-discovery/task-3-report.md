# Task 3 Report: Parse Planner Results and Assess Readiness

## Summary

Added a version-1 discriminated planning result parser for `NEEDS_DISCOVERY` and `READY_FOR_PLANNING`, plus pure readiness assessment. Discovery questions require stable IDs, a prompt, rationale, importance, and non-empty choices. Ready results require milestones with completion criteria and task objects. Validation accumulates issues. Readiness returns only unanswered important questions; low-risk details do not block planning.

## Files changed

- `packages/core/src/domain/planning-result.ts` (new)
- `packages/core/src/domain/readiness.ts` (new)
- `packages/core/src/domain/index.ts`
- `packages/core/test/planning-result.test.ts` (new)
- `packages/core/test/readiness.test.ts` (new)

## TDD evidence

- **RED:** Ran `pnpm --filter @agentic-dev-runner/core exec vitest run test/planning-result.test.ts test/readiness.test.ts` before implementation. All 7 tests failed because `parsePlanningResult` and `assessReadiness` were not exported, as expected.
- **GREEN:** Implemented the parser and readiness assessment. The same focused command passed: 2 files, 7 tests.
- Added an assertion that answered questions are excluded from the returned readiness questions, and reran the focused tests successfully.

## Verification

- `pnpm --filter @agentic-dev-runner/core exec vitest run test/planning-result.test.ts test/readiness.test.ts` — passed (2 files, 7 tests).
- `pnpm --filter @agentic-dev-runner/core typecheck` — passed.
- `git diff --cached --check` — passed before commit.
- Commit: `ebfb94f2567185060b2e89534bdc5e5b997a01fa` (`feat(core): validate planning readiness results`).

## Concerns and deviations

- Readiness accepts answered question IDs so it can suppress repeats deterministically. `PlanningInput.knownDecisions` currently stores answer strings without question IDs, so the planning service must preserve/supply answered IDs to use repeat suppression across runs. Semantic matching answers to questions is intentionally not guessed in core.
- No architecture or scope deviations.

## Follow-up: duplicate question IDs

- Added a parser check rejecting repeated question IDs with an index-specific issue.
- **RED:** Focused tests initially failed only the new duplicate-ID case: the parser accepted duplicate `database` IDs.
- **GREEN:** After the check, focused tests passed (2 files, 8 tests); core typecheck and `git diff --check` passed.
- Uncommitted pending parent confirmation, as requested.
