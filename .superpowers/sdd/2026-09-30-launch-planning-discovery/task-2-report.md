# Task 2 Report — Bounded Repository Analysis

## Summary

Implemented bounded, deterministic repository analysis for planning input. The application service shares the existing Git manager and process runner, collects optional project docs and root/package manifests, records a capped tracked-file and test inventory, captures base revision and dirty status, extracts answered `Answer:` lines, and supports repositories before their first commit.

## Files changed

- `packages/cli/src/application/planning/repository-analysis.ts`
- `packages/cli/src/application/app-services.ts`
- `packages/cli/test/repository-analysis.test.ts`

## TDD evidence

- **RED:** Ran `pnpm --filter @agentic-dev-runner/cli exec vitest run test/repository-analysis.test.ts` after adding tests and before implementation. Vitest failed to load the not-yet-created `repository-analysis.js` module (0 tests collected), as expected.
- During implementation, the first test run exposed that the fixture's `packages/app/package.json` was deeper than the initial manifest scan. The scan was adjusted to include package manifests in `packages/<name>` and `apps/<name>`.
- **GREEN:** Final focused run passed: 1 test file, 8 tests.

## Verification

- `pnpm --filter @agentic-dev-runner/cli exec vitest run test/repository-analysis.test.ts` — passed, 8 tests.
- `pnpm --filter @agentic-dev-runner/cli typecheck` — passed.
- `git diff --check` and staged diff check — passed.

## Commit

`21d204a9f8c2ce51efd2e8b62543a5c4270bc5cb` — `feat(cli): collect bounded planning repository input`

## Concerns

- For a valid Git repository without a first commit, `baseRevision` is `unborn`. Analysis succeeds as required; later planning/isolation must handle that state or explain that an initial commit is needed.
- The full CLI suite was not run; verification stayed focused on Task 2 and CLI typechecking.
- No architecture or scope deviation.

## Review follow-up

Addressed the three Task 2 review findings in the analyzer and its focused tests:

- `knownDecisions` now uses only the remaining budget after evidence content, so decisions cannot push the aggregate past 65,536 bytes.
- Test paths are derived from the full tracked-path list independently of the general 500-path inventory; test inventories over 500 paths carry an explicit truncation marker.
- Root manifest names are checked directly, so untracked `pyproject.toml`, `Cargo.toml`, and `go.mod` are included.

### RED/GREEN and verification

- **RED:** Added the three requested regression scenarios and ran the focused suite. It failed in the late test path case (inventory contained only the truncation marker), aggregate decision byte cap (165,536 bytes), and missing untracked root manifest (`pyproject.toml`).
- **GREEN:** `pnpm --filter @agentic-dev-runner/cli exec vitest run test/repository-analysis.test.ts` — passed, 1 file / 12 tests.
- `pnpm --filter @agentic-dev-runner/cli typecheck` — passed.
- `git diff --check` — passed.

Fix commit: `1ce3a428c89556f71567ceda333d0c4eec71939c` (`fix(cli): keep planning evidence within analysis caps`).

Files changed in the fix:

- `packages/cli/src/application/planning/repository-analysis.ts`
- `packages/cli/test/repository-analysis.test.ts`
- `.superpowers/sdd/2026-09-30-launch-planning-discovery/task-2-report.md`

Focused test output: `Test Files 1 passed (1); Tests 12 passed (12)`.
Typecheck output: `$ tsc --noEmit` completed successfully.

## Review follow-up 2 — retained answers and question IDs

Added required `PlanningInput.answeredQuestionIds` validation and decision parsing for stable markdown question headings (`### <id>: <prompt>`) with non-empty `Answer:` fields. The analyzer selects complete answer/ID pairs first, reserves their serialized byte cost, and budgets repository evidence against the remaining 65,536-byte serialized-input ceiling.

### TDD and verification

- **RED:** Added regression coverage for preserved answers under later large evidence, question ID linkage, and the core validator field. The core test failed because the validator output lacked `answeredQuestionIds`; the CLI tests failed because the analyzer did not return IDs and could not retain the paired answer.
- **GREEN:** `pnpm --filter @agentic-dev-runner/core exec vitest run test/planning-input.test.ts` — 1 file / 2 tests passed.
- **GREEN:** `pnpm --filter @agentic-dev-runner/cli exec vitest run test/repository-analysis.test.ts` — 1 file / 13 tests passed.
- `pnpm --filter @agentic-dev-runner/core typecheck` — `$ tsc --noEmit`, passed.
- `pnpm --filter @agentic-dev-runner/cli typecheck` — `$ tsc --noEmit`, passed.
- `git diff --check` — passed.

Files changed in this follow-up: `packages/core/src/domain/planning-input.ts`, `packages/core/test/planning-input.test.ts`, `packages/cli/src/application/planning/repository-analysis.ts`, and `packages/cli/test/repository-analysis.test.ts`.
