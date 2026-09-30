# Launch Planning and Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer analyze a repository, resolve important missing decisions, preview a validated bounded plan, explicitly approve it, and hand its tasks to the existing runner.

**Architecture:** Keep planning contracts and deterministic validation in `core`; keep filesystem scanning, planner invocation, draft files, CLI rendering, and approval coordination in CLI application services. Persist approved tasks and a `plan.approved` event atomically through `RunnerStore`; after approval, reuse the existing scheduler and execution lifecycle.

**Tech Stack:** TypeScript, Node.js built-ins, pnpm workspace, Vitest, existing AgentRuntime/GitManager/RunnerStore.

**Spec:** `docs/superpowers/specs/2026-09-30-launch-planning-dogfood-design.md` (L001–L010)

## Global Constraints

- Strict TypeScript; no production dependency additions.
- Cross-platform file/process behavior; use `node:path` and direct process invocation.
- Runner owns readiness output validation, task creation, approval, and state transitions.
- Planning input is provider-independent, bounded, deterministically ordered, and recorded with its draft.
- Drafts are non-executable until plan approval; approval imports all tasks and event in one transaction.
- Use the existing `ManualTaskInput` validator and task schema.
- Source stays local except for the configured planner invocation.

## Review Focus

- Nearly empty Git repository with absent optional files → analysis records omissions and does not fail.
- Missing project goal or planner profile → command explains the required next action without creating a draft.
- Planner returns malformed JSON, unknown version, invalid questions, or invalid tasks → bounded repair then nonzero result; nothing imported.
- Duplicate, dangling, or cyclic task dependencies → draft rejected before preview/approval.
- Draft changed after preview, task ID collision, or repeated approval → approval revalidates and imports at most once.

---

### Task 1: Add provider-independent planning contracts and planner configuration

**Files:**
- Create: `packages/core/src/domain/planning-input.ts`
- Modify: `packages/core/src/domain/project-config.ts`
- Modify: `packages/core/src/domain/agent-profile.ts`
- Modify: `packages/core/src/domain/index.ts`
- Test: `packages/core/test/planning-input.test.ts`
- Test: `packages/core/test/project-config.test.ts`
- Test: `packages/config/test/project-config-file.test.ts`

**Interfaces:**
- Produces: `PlanningInput` with `goal`, `baseRevision`, ordered repository evidence, known decisions, and existing task IDs; `ProjectConfiguration.planningProfileId` for the configured planning profile.

- [ ] Add tests for valid and malformed `PlanningInput`, including empty repositories and preserved deterministic evidence order.
- [ ] Run `pnpm --filter @agentic-dev-runner/core exec vitest run test/planning-input.test.ts test/project-config.test.ts` and confirm the new cases fail.
- [ ] Implement the smallest provider-free contract; parse `planning.profile` as a required non-empty profile id only when planning is invoked, preserving old config compatibility when the section is absent.
- [ ] Add config tests for absent/valid/unknown planner profile references and invalid values.
- [ ] Run the focused core and config tests; both must pass.

### Task 2: Build bounded repository analysis input

**Files:**
- Create: `packages/cli/src/application/planning/repository-analysis.ts`
- Create: `packages/cli/test/repository-analysis.test.ts`
- Modify: `packages/cli/src/application/app-services.ts`

**Interfaces:**
- Consumes: `PlanningInput` from Task 1 and existing `GitManager.resolveHeadRevision/status`.
- Produces: `analyzeRepository(projectRoot, goal?, existingTaskIds) -> Promise<PlanningInput>`; deterministic evidence records for required docs, root/one-level manifests, capped tracked path listing, tests, and `.agentic/decisions.md`.

- [ ] Add temp-repository tests for established, empty, missing-file, dirty-tree, size-limit, and stable-order cases.
- [ ] Run `pnpm --filter @agentic-dev-runner/cli exec vitest run test/repository-analysis.test.ts` and confirm failure.
- [ ] Implement bounded local scanning with Node filesystem APIs and existing Git state; record missing optional files as absent and cap aggregate bytes and path count.
- [ ] Run the focused test and confirm it passes.

### Task 3: Parse planner results and assess readiness

**Files:**
- Create: `packages/core/src/domain/planning-result.ts`
- Create: `packages/core/src/domain/readiness.ts`
- Modify: `packages/core/src/domain/index.ts`
- Create: `packages/core/test/planning-result.test.ts`
- Create: `packages/core/test/readiness.test.ts`

**Interfaces:**
- Produces: version-1 discriminated result for `NEEDS_DISCOVERY` questions or `READY_FOR_PLANNING` milestones/tasks; pure validation returning all issues.

- [ ] Add tests for both result variants, unknown version/kind, malformed/empty questions, missing choices, milestone completion criteria, answered questions not repeating, and a defined project that can plan without low-risk implementation questions.
- [ ] Run the two focused core tests and confirm new cases fail.
- [ ] Implement typed parsing and inspectable readiness reasons; ensure low-risk reversible details do not block readiness.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Normalize tasks and validate a whole generated DAG

**Files:**
- Create: `packages/core/src/domain/planned-task.ts`
- Create: `packages/core/src/domain/plan-validation.ts`
- Modify: `packages/core/src/domain/index.ts`
- Create: `packages/core/test/plan-validation.test.ts`

**Interfaces:**
- Consumes: parsed planner result and existing `validateManualTaskInput`.
- Produces: normalized `ManualTaskInput[]` plus accumulated validation issues; defaults are READY, priority by milestone order, workflow by risk, runner-owned provenance, empty forbidden paths, and approval for high/critical risk.

- [ ] Add tests for field normalization/defaults, duplicate/existing IDs, unknown milestones, empty milestones, unresolved dependencies, cycles, unconfigured checks, missing provenance, and task size limits.
- [ ] Run `pnpm --filter @agentic-dev-runner/core exec vitest run test/plan-validation.test.ts` and confirm failure.
- [ ] Implement normalization through the existing task validator and one whole-plan DAG check; use `task-conflicts` only to report scope/resource overlaps.
- [ ] Run the focused test and existing `task-ingestion`/`task-conflicts` tests; all must pass.

### Task 5: Persist questions and draft plans as inspectable files

**Files:**
- Create: `packages/cli/src/application/planning/plan-files.ts`
- Create: `packages/cli/src/application/planning/planner.ts`
- Create: `packages/cli/test/planning-files.test.ts`
- Create: `packages/cli/test/planner.test.ts`
- Modify: `packages/cli/src/application/app-services.ts`

**Interfaces:**
- Consumes: `PlanningInput`, parsed readiness/plan results, normalized tasks, configured planning profile, and existing agent runtime.
- Produces: `.agentic/decisions.md`, `.agentic/plans/<plan-id>/{plan.json,summary.md,input.json}`, stable plan IDs, bounded planner repair, and planner invocation isolated at the analyzed base revision.

- [ ] Add file tests for empty-repository question creation, preserving existing answers, stable serialization/digest, edited draft reads, and cleanup after planner failure.
- [ ] Add fake-runtime tests for questions, valid plan, malformed response repair success/exhaustion, and no source integration.
- [ ] Run focused CLI planning tests and confirm new cases fail.
- [ ] Implement file-backed draft/decision storage and reuse the existing GitManager/AgentRuntime at the analyzed base revision; allow the planner to write only its draft output and do not integrate source edits. Do not add a persistence table for human-editable planning files.
- [ ] Run the focused tests and confirm they pass.

### Task 6: Add analyze/plan/plan-show CLI services and readable preview

**Files:**
- Modify: `packages/cli/src/parse-args.ts`
- Modify: `packages/cli/src/application/runner-app-service.ts`
- Modify: `packages/cli/src/application/ports.ts`
- Modify: `packages/cli/src/application/store-backed-app-service.ts`
- Modify: `packages/cli/src/run-cli.ts`
- Modify: `packages/cli/src/commands/execute-commands.ts`
- Create: `packages/cli/src/render/render-analyze.ts`
- Create: `packages/cli/src/render/render-plan.ts`
- Modify: `packages/cli/test/parse-args.test.ts`
- Modify: `packages/cli/test/run-cli.test.ts`
- Create: `packages/cli/test/planning-cli.test.ts`

**Interfaces:**
- Produces: `agentic analyze`, `agentic plan --goal <text>`, `agentic plan show [<plan-id>]`; analyze reports bounded findings/readiness, plan writes questions or a validated draft, show summarizes milestones, tasks, parallelizable count, approval gates, and task details.

- [ ] Add parser tests for exact commands, missing goal/plan ID, and invalid extra arguments.
- [ ] Add command/service tests for analyze, question output, summary output, and nonzero failures.
- [ ] Run focused CLI tests and confirm the new cases fail.
- [ ] Wire each command through `RunnerAppService`; keep commands as parse/call/render and never start execution from plan generation.
- [ ] Run the focused tests and existing `run-cli`/`cli-end-to-end` tests; all must pass.

### Task 7: Approve the entire plan atomically and make it executable

**Files:**
- Modify: `packages/cli/src/parse-args.ts`
- Modify: `packages/cli/src/application/runner-app-service.ts`
- Modify: `packages/cli/src/application/store-backed-app-service.ts`
- Modify: `packages/cli/src/run-cli.ts`
- Modify: `packages/cli/src/commands/execute-commands.ts`
- Modify: `packages/cli/test/store-backed-app-service.test.ts`
- Create: `packages/cli/test/plan-approval.test.ts`
- Modify: `packages/cli/test/cli-end-to-end.test.ts`

**Interfaces:**
- Consumes: editable normalized draft from Task 5 and `RunnerStore.transaction/putTask/appendEvents`.
- Produces: `agentic plan approve <plan-id>` that revalidates, checks collisions, imports all tasks and one `plan.approved` event atomically, then writes an approved marker; duplicate approval is rejected.

- [ ] Add tests for invalid edit, duplicate task IDs, atomic rollback, successful approval event/task persistence, unapproved non-executability, and repeated approval.
- [ ] Run focused approval tests and confirm failures.
- [ ] Implement application approval using one existing store transaction; use the durable event to detect an already approved plan before writing its filesystem marker.
- [ ] Run focused approval, persistence, scheduler, and CLI E2E tests; all must pass.

### Task 8: Prove generated plans use the existing execution lifecycle

**Files:**
- Create: `packages/cli/test/planned-task-execution-e2e.test.ts`
- Modify: `packages/cli/test/fixtures/fake-opencode-coding-agent.mjs` only if its current protocol cannot serve a fake planner response.

**Interfaces:**
- Consumes: plan generation and approval CLI/application services from Tasks 5–7.
- Produces: an automated fake-agent flow from goal through questions, plan approval, scheduler execution, verification, and integrated DONE state.

- [ ] Add a small end-to-end test with two dependent tasks and a questions-first planning result; assert no task exists before approval and both tasks reach DONE after approval and run.
- [ ] Run the focused test and confirm it fails before wiring is complete.
- [ ] Reuse the existing fake agent and execution fixtures; add no second scheduler or special planner execution path.
- [ ] Run the focused end-to-end test and existing `multi-task-dag-e2e.test.ts`.

### Task 9: Run the planning workstream checks

**Files:** No new files.

- [ ] Run core, config, and CLI targeted suites for changed modules.
- [ ] Run `pnpm --filter @agentic-dev-runner/core typecheck`, `pnpm --filter @agentic-dev-runner/config typecheck`, and `pnpm --filter @agentic-dev-runner/cli typecheck`.
- [ ] Run workspace `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`; fix failures in this workstream before handoff.
