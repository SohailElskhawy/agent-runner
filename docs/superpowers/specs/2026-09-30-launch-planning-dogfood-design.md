# v0.1 Technical Preview — Planning, Routing, and Dogfood Design

**Date:** 2026-09-30

**Status:** Awaiting user review

**Source of truth:** `docs/LAUNCH_SPRINT_ROADMAP.md`

**Supersedes where conflicting:** `2026-09-28-planning-routing-adapters-v0.1-design.md`

## Goal

Complete the local-first product loop for the v0.1 Technical Preview: analyze a repository and goal, ask for important missing decisions, propose a bounded executable task DAG, require explicit approval, and run approved tasks through the existing verified execution engine. A small TODO web app dogfood run will exercise the empty-project path.

## Scope and exclusions

This design covers L001–L015. L016's push, tag, GitHub release, npm publication, and post-publication smoke test remain separate external actions, each requiring confirmation under `docs/RELEASE.md`.

The existing OpenCode and Codex adapters remain the only supported adapters for this sprint. Claude, Gemini, Antigravity, Copilot, and other provider additions are excluded by the launch roadmap. GUI, remote execution, learned routing, dollar cost analytics, and general-purpose product design remain out of scope.

`docs/LAUNCH_SPRINT_ROADMAP.md` is the launch contract. The canonical README, project specification, architecture, v0.1 scope, roadmap, task schema, contributing guide, and release notes must agree with it. In particular, v0.1 is labeled Technical Preview / Early Access, planning and lightweight discovery are included, and interactive discovery sessions remain excluded.

## Product flows

### Defined project

```text
goal + repository
→ bounded analysis
→ READY_FOR_PLANNING
→ generated and validated plan
→ preview and explicit approval
→ approved tasks in existing scheduler
→ verify and integrate
```

### Incomplete or empty project

```text
goal + repository
→ bounded analysis
→ NEEDS_DISCOVERY with targeted questions
→ developer records answers in .agentic/decisions.md
→ re-analyze and plan
→ preview and explicit approval
→ approved tasks in existing scheduler
→ verify and integrate
```

The runner owns readiness, plan validation, durable approval, task import, and all execution state transitions. A planning agent can return questions or a draft; it cannot activate tasks, grant approval, alter runner state, or expand an approved plan.

## Planning input and repository analysis

Add a provider-independent `PlanningInput` domain contract. It contains the requested goal, repository root identity, base Git revision, known product and architecture decisions, bounded repository evidence, and the ordered list of existing task IDs. It contains no adapter, model, or provider fields.

The CLI application builds this input from local files. Initial evidence includes `AGENTS.md`, project specification/architecture/ADR/roadmap Markdown, root and one-level-down package manifests, a capped tracked-file tree, applicable test paths, and `.agentic/decisions.md`. Missing optional files are recorded as absent. The input and its digest are stored with each draft so users can inspect what informed a plan. Source file contents are not collected wholesale.

Analysis works with an existing repository and a nearly empty Git repository. It requires a goal and a usable Git repository, but not `AGENTS.md`, a manifest, source files, or tests. Findings and omissions are visible in the analyze output.

## Readiness and discovery

The planner returns one versioned result:

- `NEEDS_DISCOVERY`: decision-oriented questions with an explanation of why each answer affects the roadmap.
- `READY_FOR_PLANNING`: a finite set of milestones and draft tasks.

Questions cover decisions that change product behavior or system boundaries. Reversible implementation details with low cost of change do not block planning. Questions are written to `.agentic/decisions.md` with empty answer fields; the user edits that file and reruns planning. Planning terminates in a validated draft or a clear validation failure after a bounded repair budget.

No autonomous interactive question/answer session is required. The durable decisions Markdown file is the human-editable source of those answers.

## Plan contract, validation, and approval

Draft task entries are normalized into the existing `ManualTaskInput`/`Task` contract. The planner provides task identity, objective, acceptance criteria, milestone, dependencies, provenance source, allowed paths, resources, risk, task type, routing requirements, and verification requirements. The runner fills defaults only where existing conventions define them, then calls the existing strict task validator.

Before a draft is previewed, the runner validates the whole plan: unique non-colliding task IDs, existing milestones, at least one task per milestone, resolved dependencies, acyclic graph, valid task fields, configured verification names, explicit provenance, and bounded task size. Drafts above medium complexity, with over five acceptance criteria, or over eight allowed paths are rejected with a request to split them. Scope/resource conflicts are reported before execution; they do not make safe conflicts executable in parallel.

Drafts live under `.agentic/plans/<plan-id>/` with a normalized task file, human-readable summary, and planning-input record. Users can inspect and edit the draft before approval. `agentic plan approve <plan-id>` revalidates the edited draft, checks task-ID collisions again, and imports all tasks plus a durable plan approval event in one transaction. A draft that is rejected, invalid, or not approved cannot be scheduled. A plan cannot be approved twice.

Approved tasks enter the existing SQLite task store and use the current scheduler, workflow, worktree, verification, retry, recovery, and integration code. There is no separate planner-controlled execution path.

## Cheap-first routing

Agent profiles gain an optional `tier`: `economy`, `standard`, or `strong`. Omitted tiers behave as `standard` for compatibility. Routing is deterministic and filters by availability and required capabilities before selecting the cheapest eligible profile, retaining configuration order as a tie-breaker.

The minimum permitted tier is:

- `strong` for large complexity or high/critical risk.
- `standard` for medium complexity or medium risk.
- `economy` otherwise.

Each prior failed attempt raises the minimum by one tier, capped at `strong`. This never increases the task's existing attempt budget and never silently downgrades when a qualifying profile is unavailable. Every successful route records profile, selected tier, required tier, attempt count, and reason as a durable event displayed by `agentic inspect`.

## CLI experience

The primary path is:

```text
agentic init
agentic analyze
agentic plan --goal "..."
agentic plan show [<plan-id>]
agentic plan approve <plan-id>
agentic run --parallel 4
agentic status
```

`analyze` presents readiness and collected evidence. `plan` produces questions or a draft without executing anything. `plan show` supports review before activation. Approval is explicit and durable. Existing operator commands such as `tasks`, `inspect`, `retry`, `doctor`, and `agents` remain available. Errors state the next action, and the normal workflow does not require users to hand-write task JSON.

## Dogfood and verification

Automated tests use fake planner/runtime adapters and the existing CLI/application execution path. They cover bounded input construction, missing files, readiness questions, decision persistence, plan repair and validation, DAG errors, plan editing, approval transactionality/idempotence, cheap-first routing and escalation, and approved-plan execution through the scheduler.

Run two real-agent dogfood scenarios where local authentication and provider access are available:

1. A defined project generates at least ten bounded tasks, approves them, and runs with safe parallelism. The existing 20-task synthetic execution suite remains a separate engine stress check.
2. A nearly empty repository starts with a natural-language goal, asks questions, records answers, produces and approves a plan, and builds a usable TODO web app with a small number of tasks and configured verification.

The TODO app is the requested small product example, not a replacement for the defined-project dogfood acceptance. Record actual provider, commands, task outcomes, routing, verification, commits, and limitations in `docs/DOGFOOD.md`. If live provider auth is unavailable, report the exact blocker and retain automated fake-provider evidence without claiming real-agent completion.

L015 covers local build, typecheck, lint, unit/E2E, pack smoke, provider-failure, forced-kill, parallel-stress, dogfood evidence, and the existing Windows/macOS/Linux CI matrix. No release is called complete without recording any unavailable gate.

## Architecture boundaries

- Core owns provider-independent planning and routing contracts and pure validation/policy logic.
- CLI application services collect files, invoke the configured planner through the existing agent runtime, store drafts/decisions, and coordinate approval.
- Persistence remains behind `RunnerStore`; task import and the plan approval event are atomic.
- Existing scheduler and Git/worktree/verification components remain authoritative after approval.
- Provider-specific prompt formatting and adapter behavior stay inside existing adapter boundaries.
- Repository evidence and user decisions stay local by default; only configured agent invocation sends selected planning input to a provider.
- No new production dependency, database, service, adapter family, or generic plugin mechanism is introduced by this design.

## Risks and limits

- Planning quality depends on the configured planning profile; strict validation bounds unsafe or malformed output but cannot prove product completeness.
- Repository evidence is intentionally bounded. Large repositories may require a future relevance-retrieval feature, which is outside this sprint.
- Cost tiers express relative user-configured preference, not token prices or guaranteed dollar savings.
- Live dogfood depends on provider availability, authentication, quota, and execution time. These conditions must be reported as evidence, not inferred from mock tests.
- The roadmap's target date, September 27, 2026, is in the past as of this design. Documentation should report actual completion/release dates rather than preserve it as a future target.

## Review checklist

- [x] Preserves runner ownership of task state, explicit approval, verification authority, isolation, and controlled integration.
- [x] Uses the strict existing task schema and execution engine after approval.
- [x] Keeps planning inputs provider-independent and bounded.
- [x] Keeps discovery lightweight and human-editable.
- [x] Excludes provider expansion and external release actions from this pass.
- [x] Includes a small TODO app dogfood while retaining the defined-project acceptance.
- [x] Identifies the stale roadmap target date and live-provider constraints.
