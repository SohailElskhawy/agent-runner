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

Fixes remain uncommitted pending the task owner's commit go-ahead.
