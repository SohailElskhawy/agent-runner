# Launch Docs, Dogfood, and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the v0.1 Technical Preview docs and CLI, prove planning and execution on defined and empty TODO projects, and record release verification evidence without publishing.

**Architecture:** Keep documentation aligned with the approved launch design and actual CLI behavior. Use reproducible scratch Git fixtures and the production CLI path for dogfood; record real-provider evidence separately from fake-provider automated test evidence.

**Tech Stack:** Markdown, existing `agentic` CLI, Node.js built-ins, Git, existing CI/pack/test scripts.

**Spec:** `docs/superpowers/specs/2026-09-30-launch-planning-dogfood-design.md` (L001, L012–L015)

## Global Constraints

- Label v0.1 as Technical Preview / Early Access and report actual dates.
- No new providers, integrations, GUI, deployment, or external publishing in this pass.
- Preserve the manual task path for advanced users.
- Do not claim real-agent or cross-platform success without captured evidence.
- Use the actual runner for dogfood; no hand-written mock substitute for the requested TODO app.
- Keep generated fixture state out of the source tree's normal Git status.

## Review Focus

- README commands must exist and match `agentic help`.
- Defined-project dogfood must produce at least ten tasks and safely exercise parallel execution.
- Empty-project dogfood must ask questions, persist answers, then produce an approved runnable plan.
- Failed provider/auth/quota checks must be recorded as blockers and not called successful dogfood.
- External publish/tag/push steps remain pending explicit authorization.

---

### Task 1: Align canonical project and release documentation

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/PROJECT_SPEC.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/V0.1_SCOPE.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/TASK_SCHEMA.md`
- Modify: `docs/LAUNCH_SPRINT_ROADMAP.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/RELEASE.md`

**Interfaces:**
- Consumes: implemented CLI command names and behavior from the Planning and Routing plans.
- Produces: one consistent v0.1 Technical Preview contract; explicit planning/discovery inclusion, cheap-first tiers, remaining v0.2 exclusions, updated actual date, and L001–L015 completion evidence/status. L016 remains pending external authorization.

- [ ] Add or update documentation assertions where existing tests cover task-schema/README command consistency; assert planning and tier settings match actual parsers/config.
- [ ] Run the focused documentation tests and identify stale expectation failures.
- [ ] Update the canonical docs without broad unrelated rewrites; preserve accepted architecture and scope constraints.
- [ ] Run focused doc/schema tests and check all README commands against CLI help.

### Task 2: Polish first-run CLI guidance and generated-plan presentation

**Files:**
- Modify: `packages/cli/src/parse-args.ts`
- Modify: `packages/cli/src/render/render-analyze.ts`
- Modify: `packages/cli/src/render/render-plan.ts`
- Modify: `packages/cli/test/parse-args.test.ts`
- Modify: `packages/cli/test/run-cli.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: analyze/plan/show/approve behavior from the Planning plan and tier explanation from the Routing plan.
- Produces: short actionable errors, readable roadmap/task preview, first-run quickstart, tier/escalation details, and advanced manual-task guidance.

- [ ] Add tests for malformed planning commands and plan output readability/next-step messages.
- [ ] Run focused parser/render tests and confirm failures.
- [ ] Make only the presentation changes needed to satisfy L014; keep orchestration in application services.
- [ ] Run focused CLI tests and compare `agentic help` with README examples.

### Task 3: Add reproducible TODO dogfood fixtures

**Files:**
- Create: `scripts/dogfood/todo-app-fixture.mjs`
- Create: `scripts/dogfood/todo-app-spec/PROJECT_SPEC.md`
- Create: `scripts/dogfood/todo-app-spec/AGENTS.md`
- Modify: `.gitignore`
- Test: `scripts/dogfood/todo-app-fixture.test.mjs` (only if fixture generation includes branching/cleanup logic that needs a failure check)

**Interfaces:**
- Produces: commands to create isolated defined and nearly empty Git repositories under an ignored `.agentic-dogfood/` directory. The defined fixture contains enough written scope for a 10+ task plan; the empty fixture contains only a goal and no decisions. Both configure runner verification with Node's built-in test runner.

- [x] Add an assert-based fixture self-check for generated repository layout, Git initialization, verification command, and empty-vs-defined contents.
- [x] Run the self-check and confirm it fails before the generator exists.
- [x] Implement the smallest cross-platform Node script using `node:fs`, `node:path`, `node:os`, and direct `node:child_process` argument arrays.
- [x] Run the self-check and verify generated repositories remain ignored by the outer repository.

### Task 4: Run the defined-project real-agent dogfood (L012)

**Files:**
- Modify: `docs/DOGFOOD.md`
- Fixture generated under ignored `.agentic-dogfood/`.

**Interfaces:**
- Consumes: planning, approval, routing, and execution commands from the other workstreams.
- Produces: evidence for a written TODO project generating at least ten bounded tasks, explicit plan approval, safe parallel execution with a real configured agent, verification, integration, retries, and inspectable history.

- [ ] Generate the defined TODO project and confirm `agentic analyze`/`plan` accept it with its configured profile.
- [ ] Generate and inspect the 10+ task plan; verify task schema, DAG, scope, and verification before approval.
- [ ] Approve and run with safe parallelism using an installed/authenticated real agent.
- [ ] Capture provider/profile, commands, task statuses, routing events, verification evidence, commit history, and any bounded failure in `docs/DOGFOOD.md`.
- [ ] Confirm the app is usable and the defined project is in a healthy verified state; if live auth/quota is unavailable, record the exact blocker without marking L012 complete.

### Task 5: Run the empty-project TODO web app dogfood (L013)

**Files:**
- Modify: `docs/DOGFOOD.md`
- Fixture generated under ignored `.agentic-dogfood/`.

**Interfaces:**
- Consumes: empty fixture, readiness/questions path, decision file, draft approval, existing runner scheduler, and configured verification.
- Produces: a working small TODO website built through the actual runner, verified in its integrated Git repository.

- [ ] Create the empty fixture and run analysis/planning with a natural-language TODO app goal.
- [ ] Assert specific important questions are emitted and no task is executable before decisions/approval.
- [ ] Record answers in `.agentic/decisions.md`, rerun planning, inspect the bounded plan, and approve it.
- [ ] Run with a real available agent, then inspect task state, commits, routing, and verification.
- [ ] Open the resulting `index.html` in a browser and check add, complete, delete, and reload persistence; record exact outcomes and app location in `docs/DOGFOOD.md`.
- [ ] If live agent access is blocked, preserve the fixture and record the exact provider/auth/quota failure; do not claim a working app was produced.

### Task 6: Complete L015 release verification without external publication

**Files:**
- Modify: `docs/RELEASE.md`
- Modify: `docs/DOGFOOD.md`
- Modify: `docs/LAUNCH_SPRINT_ROADMAP.md`

**Interfaces:**
- Consumes: completed implementation, both dogfood records, and existing CI workflow.
- Produces: local verification record, pack smoke result, provider-failure/recovery/parallel results, CI status across Windows/macOS/Linux, and an explicit pending state for L016.

- [ ] Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
- [ ] Run `AGENTIC_PACK_SMOKE=1 pnpm test` and the release-focused provider-failure, forced-kill, parallel-stress, and 20-task suites.
- [ ] Run the configured real-agent dogfood flows and record evidence from Tasks 4–5.
- [ ] Inspect `.github/workflows/ci.yml`; use CI results for Windows/macOS/Linux and report any missing platform evidence accurately.
- [ ] Mark each L001–L015 item in `docs/LAUNCH_SPRINT_ROADMAP.md` only after its acceptance evidence exists; leave L016 pending confirmation for each outward action.
- [ ] Review `git diff`, ensure no generated scratch data or credentials are tracked, and report unresolved release blockers.
