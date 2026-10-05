# SDD ledger — plan: docs/superpowers/plans/2026-09-30-launch-planning-discovery.md

## Preflight overlap scan

| Tasks/files/interfaces | Check | Ruling |
|---|---|---|
| 1 → 2: `PlanningInput`, planning profile → repository scanner | Contract is provider-free; scanner fills it from local files and Git evidence. | No conflict; implement sequentially. |
| 1, 3, 4: `packages/core/src/domain/index.ts` | Each exports contracts or validators introduced by earlier task. | No conflict; later tasks extend existing exports. |
| 2, 5, 6: `packages/cli/src/application/app-services.ts` | Scanner, planner runtime, then command service wiring. | No conflict; keep integration sequential and preserve the narrow service boundary. |
| 3 → 4 → 5: planner result → normalized task DAG → draft file service | Result validation precedes task validation; drafts store only validated normalized tasks. | No conflict; order is required. |
| 6, 7: parse/dispatch/app service files | Plan create/show commands land before `plan approve`; existing task `approve` stays distinct. | No conflict; add a separate plan subcommand branch. |
| 7 → 8: transactional task import → scheduler E2E | Approved tasks use current scheduler; E2E asserts no import before approval. | No conflict; preserve runner authority. |
| Task 9: verification only | Does not change files. | No conflict. |

## Task self-consistency

| Task | Files/tests/interfaces agree? | Ruling |
|---|---|---|
| 1 | Core contract and config tests cover emitted interfaces. | Proceed. |
| 2 | Scanner tests cover filesystem and Git evidence with temp repos. | Proceed. |
| 3 | Versioned result/readiness behavior is tested in core. | Proceed. |
| 4 | Defaults and whole-DAG validation consume Task 3 and existing task validator. | Proceed. |
| 5 | Draft/question storage and fake planner use validated Task 4 output. | Proceed. |
| 6 | CLI parses, calls, and renders the Task 5 analysis/planning services. | Proceed. |
| 7 | Approval revalidates files and atomically uses existing store APIs. | Proceed. |
| 8 | E2E exercises the public flow and production scheduler. | Proceed. |
| 9 | Verification commands match workspace scripts. | Proceed. |

## Baseline

- Worktree: `/home/sohail/.codex/worktrees/agent-runner-launch-sprint`, branch `feat/launch-sprint-implementation`.
- `pnpm install --frozen-lockfile --offline` failed because pnpm policy metadata was not cached; online frozen install succeeded.
- `pnpm build` passed.
- Initial `pnpm test` before build failed because workspace `dist` outputs were absent.
- `pnpm test` after build passed: 11 workspaces, 901 passed, 6 skipped.

## Progress

- Task 1: complete (commit 04fc6ec; focused core/config tests, typechecks, and lint passed; task review approved).
- Task 2: complete (commits 21d204a, 1ce3a42, 256f3df, f5f1e1c, 8e81373; analyzer and core validation focused tests/typechecks passed; final read-only review approved. Revisions covered path inventory, untracked root manifests, retaining answers under evidence pressure, stable answer IDs, serialized JSON byte budgeting, and answer/ID pair validation).
- Task 3: complete (commits ebfb94f and 9587b62; focused tests passed; duplicate question IDs rejected; read-only review approved. Task 5 must pass answered IDs into readiness and invoke the planner again after discovery is resolved).
- Task 4: complete (commit 95d38f6; plan-validation/task-ingestion/task-conflicts suites 43/43, core typecheck and diff check passed; read-only re-review approved. Low-risk uses `simple`; size and configured-check issues accumulate with schema errors).
- Task 5: in progress (Luna implementer working on decision and draft files plus planner invocation).

## Rulings

- Ruling: remove `packages/config/src/project-config-file.ts` from Task 1's modify list — its loader already delegates parsed YAML to the changed core validator, and the config loader test covers the full path — cost if wrong: future parser behavior would need a config-layer change, but the current architecture has no duplicate validation to update.
- Ruling: analysis accepts a repository with no first commit and records `baseRevision: "unborn"`; the real execution dogfood will make a baseline commit containing its seed specification before plan approval/run — the launch scope requires a nearly empty repo flow but does not require the runner to create the repository's first commit — cost if wrong: an empty Git index alone cannot supply the worktree base the existing executor requires.
- Ruling: `READY_FOR_PLANNING` means no important unanswered questions remain, not that a task DAG already exists; the planning service invokes the planner again to obtain and validate the actual draft — this keeps readiness and planning separate — cost if wrong: the discovery flow may use one additional planner invocation.
