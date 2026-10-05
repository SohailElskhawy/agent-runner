# Agentic Dev Runner — Launch Sprint Roadmap

**Sprint target:** Sunday, September 27, 2026 (elapsed; verification status reviewed September 30, 2026)

**Release type:** v0.1 Technical Preview / Early Access

## Product Goal

Agentic Dev Runner turns a software project into many small, bounded engineering tasks, routes routine work to inexpensive capable models, escalates when necessary, and executes the approved roadmap hands-free with verification, recovery, and controlled integration.

It must support two primary entry points:

### 1. Well-Defined Existing Project

```text
well-defined repository/specification
→ analyze project
→ derive bounded milestones
→ decompose into mini tasks
→ validate task DAG
→ preview + approve roadmap
→ route tasks cheap-first
→ execute autonomously
→ verify
→ integrate
→ DONE
```

### 2. Poorly Defined or Empty Project

```text
new / incomplete project
→ analyze available context
→ identify missing decisions
→ discovery with developer
→ persist decisions
→ derive bounded milestones
→ decompose into mini tasks
→ validate task DAG
→ preview + approve roadmap
→ route tasks cheap-first
→ execute autonomously
→ verify
→ integrate
→ DONE
```

## Core Product Principle

Planning may be probabilistic.

Execution must remain deterministic.

The planner may propose a roadmap, but once the developer approves it, Agentic Dev Runner executes a fixed, auditable task contract. Agents cannot silently expand project scope, mark themselves complete, or bypass runner-controlled verification and integration.

## Launch-Sprint Scope

This sprint is deliberately narrow. The goal is not to finish every future capability. The goal is to validate the first complete version of the product idea:

> repository + goal → analyze → plan → approve → hands-free execution

The existing execution engine remains the foundation. This sprint adds the missing planning and discovery loop, then validates it with real agents.

---

# Launch Tasks

## L001 — Align Product Contract

**Priority:** P0

Update the canonical project documents so they consistently describe the two supported workflows:

1. well-defined project → direct planning
2. incomplete/empty project → discovery before planning

### Acceptance

- README, PROJECT_SPEC, ROADMAP, V0.1_SCOPE, and related docs agree on launch scope
- autonomous planning/task generation is no longer described inconsistently as both v0.1 and deferred v0.2
- release positioning is explicitly Technical Preview / Early Access
- no unrelated roadmap expansion

---

## L002 — Define ProjectBrief / Planning Input

**Priority:** P0  
**Depends on:** L001

Introduce a normalized planning input representing:

- project goal
- repository context
- known product decisions
- known architectural decisions
- constraints
- available documentation
- discovery answers
- base revision

### Acceptance

- planning input is provider-independent
- it can represent both existing projects and empty repositories
- it is persisted/reproducible where required
- no planning-agent-specific concepts leak into core domain contracts

---

## L003 — Implement Repository Analysis

**Priority:** P0  
**Depends on:** L002

Implement `agentic analyze`.

Analysis should gather enough information for readiness assessment, including where applicable:

- AGENTS.md
- project specifications
- architecture documents
- ADRs
- manifests/package files
- repository structure
- relevant tests
- existing source structure
- Git state/history required by planning

### Acceptance

- analysis works on an established project
- analysis works on a nearly empty repository
- project source remains local except for configured model access
- collected context is bounded and reproducible
- missing files are handled explicitly rather than treated as errors when appropriate

---

## L004 — Implement Readiness Assessment

**Priority:** P0  
**Depends on:** L003

Determine whether enough information exists to create an executable roadmap.

Expected outcomes:

```text
READY_FOR_PLANNING
NEEDS_DISCOVERY
```

### Acceptance

- important missing product/architecture decisions cause NEEDS_DISCOVERY
- reversible low-risk implementation details do not create unnecessary questions
- the runner does not silently invent important decisions
- readiness reasoning is inspectable

---

## L005 — Implement Discovery Questions

**Priority:** P0  
**Depends on:** L004

When readiness is incomplete, generate targeted questions for the developer.

Examples:

- framework/runtime
- persistence model
- authentication requirements
- deployment scope
- critical integrations
- important architectural constraints

### Acceptance

- questions are specific and decision-oriented
- unnecessary questions are avoided
- answers are persisted as project decisions
- the developer can re-run readiness after answering
- discovery terminates when the project is sufficiently defined

---

## L006 — Implement Bounded Roadmap Generation

**Priority:** P0  
**Depends on:** L004, L005

Generate milestones from the approved project goal and known decisions.

### Acceptance

- roadmap is finite
- every milestone maps back to project requirements or explicit user decisions
- speculative "nice to have" work is excluded
- milestones have clear completion criteria
- roadmap output is reproducible enough to inspect and approve

---

## L007 — Implement Mini-Task Generation

**Priority:** P0  
**Depends on:** L006

Decompose milestones into strict existing Task-schema objects.

Generated tasks should contain:

- id
- title
- milestone
- objective
- acceptance criteria
- dependencies
- provenance
- allowed/forbidden scope
- logical resources
- workflow
- risk
- routing complexity/capabilities
- verification requirements
- retry/review limits
- approval requirements

### Acceptance

- each task represents one independently reviewable capability
- tasks are small enough for focused agent execution
- acceptance criteria are observable and testable where practical
- provenance is explicit
- generated task files pass the existing task validator without manual conversion
- oversized tasks are flagged for decomposition before execution

---

## L008 — Build and Validate Generated DAG

**Priority:** P0  
**Depends on:** L007

Validate the generated roadmap before it becomes executable.

### Acceptance

- dependency graph is acyclic
- dependency references are valid
- task IDs are unique
- resource declarations are valid
- unsafe scope/resource overlaps are detected
- oversized tasks are rejected or returned for decomposition
- tasks with missing provenance or invalid verification requirements cannot enter execution

---

## L009 — Add Plan Preview and Approval

**Priority:** P0  
**Depends on:** L008

The developer must be able to inspect the proposed roadmap before execution.

Example:

```text
Proposed roadmap
────────────────────────────────
4 milestones
18 tasks
6 parallelizable immediately
2 approval-gated

Review generated tasks? [Y/n]
```

### Acceptance

- generated milestones/tasks can be inspected before activation
- approval is explicit and durable
- rejected plans remain non-executable
- individual tasks can be inspected
- approval does not allow the planner to silently add later speculative work

---

## L010 — Connect Planning to Existing Execution Engine

**Priority:** P0  
**Depends on:** L009

Approved generated tasks must flow directly into the existing scheduler/workflow engine.

Expected flow:

```text
goal
→ analyze
→ readiness/discovery
→ roadmap
→ mini tasks
→ approve
→ persist executable DAG
→ run
```

### Acceptance

- no manual JSON conversion is required between planning and execution
- existing task state machine remains authoritative
- existing worktree isolation, verification, integration, retry, and recovery behavior is reused
- planner does not gain orchestration-state authority

---

## L011 — Add Cheap-First Routing Profile

**Priority:** P0  
**Depends on:** L010

Make cost-aware execution a first-class product behavior.

The router should prefer the cheapest configured capable model for suitable tasks while respecting:

- task complexity
- task risk
- required capabilities
- context requirements
- user policy
- provider availability

A stronger model may be used when risk requires it or when a cheaper model fails.

Example policy:

```text
trivial / low-risk
→ cheap model

small / low-risk
→ cheap model

medium
→ standard model

high-risk / complex
→ stronger model

cheap model repeatedly fails verification
→ escalate

code review
→ optionally stronger/different model

verification
→ runner-controlled commands

integration
→ runner-controlled Git workflow
```

### Acceptance

- routing remains deterministic
- capability/risk constraints override cost optimization
- escalation is bounded
- routing decisions are inspectable
- no learned/adaptive routing is introduced in this sprint

---

## L012 — Defined-Project Real-Agent Dogfood

**Priority:** P0  
**Depends on:** L010, L011

Use a real, sufficiently defined repository/specification.

### Target Flow

```text
existing project
→ analyze
→ READY_FOR_PLANNING
→ generate >=10 bounded tasks
→ approve
→ execute with real agents
→ verify
→ integrate
→ complete roadmap
```

### Acceptance

- real provider invocations are used
- generated tasks require no manual schema rewriting
- multiple safe tasks execute concurrently
- failures/retries remain bounded
- complete Git/state/event history remains inspectable
- project ends in a healthy verified state

---

## L013 — Empty-Repository Real-Agent Dogfood

**Priority:** P0  
**Depends on:** L010, L011

Start with a new or nearly empty Git repository and a natural-language goal.

Example:

```text
Build a personal expense tracker web app.
```

Expected flow:

```text
empty repo
→ analyze
→ NEEDS_DISCOVERY
→ targeted user questions
→ persist decisions
→ READY_FOR_PLANNING
→ generate roadmap
→ generate mini tasks
→ approve
→ execute
→ working verified project
```

### Acceptance

- discovery asks for important missing decisions
- planner does not silently choose important product/architecture decisions
- generated roadmap is finite
- tasks are small/bounded
- real agents execute the roadmap
- final repository is usable and verified
- execution remains inspectable and recoverable

---

## L014 — CLI UX and Quickstart Polish

**Priority:** P0  
**Depends on:** L010

Polish the primary launch workflow.

Target developer experience:

```bash
agentic init
agentic analyze
agentic plan
agentic run --parallel 4
agentic status
```

Also preserve advanced/operator commands such as:

```bash
agentic tasks
agentic inspect <task-id>
agentic approve <task-id>
agentic retry <task-id>
agentic doctor
agentic agents
```

### Acceptance

- first-run workflow is obvious from README/CLI help
- errors explain the required next action
- generated planning output is readable
- task-schema internals are not required knowledge for normal first-time usage
- advanced users can still inspect/edit task definitions directly

---

## L015 — Release Verification

**Priority:** P0  
**Depends on:** L012, L013, L014

Run the complete release checklist.

### Required Verification

- workspace build
- typecheck
- lint
- full unit/E2E suites
- packed npm install smoke test
- Windows CI
- macOS CI
- Linux CI
- provider-failure tests
- forced-kill recovery tests
- parallel stress tests
- defined-project real-agent dogfood
- empty-project real-agent dogfood

### Acceptance

- all required suites pass
- clean npm installation works
- no known critical or high-severity release blocker remains
- release documentation accurately describes known limitations

---

## L016 — Publish v0.1.0 Technical Preview

**Priority:** P0  
**Depends on:** L015

Publish the first public Technical Preview.

### Acceptance

- master pushed to remote
- release commit/tag created
- GitHub release published
- npm package published
- CHANGELOG updated
- installation instructions verified
- Technical Preview / Early Access status clearly stated
- known limitations documented
- next roadmap starts after release rather than expanding this sprint

---

# Execution Status and Evidence

**Reviewed:** September 30, 2026

| Task | Status | Evidence |
|---|---|---|
| L001 | Complete | Product, architecture, scope, roadmap, task schema, release, and onboarding docs align on Technical Preview / Early Access. |
| L002 | Complete | Provider-independent planning input and persistence are covered by planning tests. |
| L003 | Complete | `agentic analyze` was exercised on the established project and nearly empty TODO fixture; bounded evidence is reported. |
| L004 | Complete | Readiness tests cover `READY_FOR_PLANNING` and `NEEDS_DISCOVERY`. |
| L005 | Complete | Empty-project dogfood asked a storage decision and persisted the answer before replanning. |
| L006 | Complete | Planner generated inspectable bounded plans for both TODO fixtures. |
| L007 | Complete | Generated plans passed task validation; the defined-project plan contained 10 tasks. |
| L008 | Complete | DAG validation and rejection cases are covered by planning tests. |
| L009 | Complete | Plan preview and durable approval were exercised in both live dogfood runs. |
| L010 | Complete | Approved plans used the existing scheduler, verification, worktree, and integration flow. |
| L011 | Complete | Cheap-first routing, bounded escalation, and inspect output are covered by tests; live runs recorded routing decisions. |
| L012 | Complete | 10-task defined-project Codex dogfood finished with 10 DONE tasks and 10 completed integrations. See [DOGFOOD.md](DOGFOOD.md#planning-and-todo-app-dogfood-l012l013). |
| L013 | Complete | Empty-project discovery, one-task Codex execution, integration verification, unit test, and Chromium interaction check passed. See [DOGFOOD.md](DOGFOOD.md#nearly-empty-project-l013). |
| L014 | Complete | README quickstart, CLI help, planning preview, and operator commands are documented and covered by CLI tests. |
| L015 | Open | Local lint, typecheck, build, full workspace tests, provider-failure/recovery/parallel stress suites, and packed install smoke passed. The live 20-task Codex run reached 20 DONE with 20 task commits, but T09 used direct execution, leaving 19 of 20 tasks in the serialized queue. Windows/macOS/Linux CI, a complete 20-entry queue run, and successful live execution through a second adapter remain outstanding. |
| L016 | Pending | Wait for L015 and separate explicit authorization before pushing, tagging, publishing the GitHub release, or publishing to npm. |

## Local Release Verification

| Check | Result |
|---|---|
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `AGENTIC_PACK_SMOKE=1 pnpm test` | Pass, including packed-install smoke |
| `node scripts/dogfood/todo-app-fixture.mjs --check` | Pass |
| Windows / macOS / Linux CI | Not run for this worktree |
| Live 20-task real-agent dogfood | Partial: 20 DONE, 20 task commits, 40 tests pass; 19 completed queue entries, one task used direct execution |
| Second live agent adapter | Not verified; Codex passed, but OpenCode Go quota was exhausted and no OpenCode task completed |

The launch sprint implementation and both TODO dogfood paths have local
evidence. Release verification remains open until cross-platform CI, successful
live execution through a second adapter, and the complete 20-entry queue gate
have results.

# Target CLI Experience

## Well-Defined Project

```bash
agentic init

agentic plan   --goal "Implement the project defined in docs/PROJECT_SPEC.md"
```

Expected:

```text
Analyzing repository...

Project readiness: READY_FOR_PLANNING

Proposed roadmap
────────────────────────────────
4 milestones
18 tasks
6 parallelizable immediately
2 approval-gated
Estimated max parallelism: 4

Review generated tasks? [Y/n]
```

Then:

```bash
agentic run --parallel 4
```

---

## New / Empty Project

```bash
mkdir expense-tracker
cd expense-tracker
git init

agentic init
agentic plan --goal "Build a personal expense tracker web app"
```

Expected:

```text
Analyzing project...

Project readiness: NEEDS_DISCOVERY

I need several decisions before I can safely create the roadmap.

1. Web framework?
2. Authentication required?
3. Database?
4. Initial deployment target?
```

After answers:

```text
Project readiness: READY_FOR_PLANNING

Creating bounded roadmap...

Milestone 1 — Project foundation
  T001 Initialize application
  T002 Configure TypeScript/linting
  T003 Configure persistence

Milestone 2 — Authentication
  T004 Define user model
  T005 Implement registration
  T006 Implement login
  T007 Add protected routes

Milestone 3 — Core product functionality
  ...
```

The user approves the generated plan once, after which Agentic Dev Runner owns execution inside the approved bounded roadmap.

---

# Explicitly Out of Scope for This Launch Sprint

Do not add before the v0.1 Technical Preview unless required to fix a release blocker:

- Claude adapter
- Antigravity adapter
- GUI
- cloud control plane
- remote workers
- distributed orchestration
- Jira integration
- Linear integration
- GitHub PR automation
- deployment automation
- learned/adaptive routing
- sophisticated cost analytics
- provider marketplace
- plugin framework
- team collaboration
- notifications
- arbitrary workflow plugins

Provider expansion begins after the launch. Claude Code is the preferred next direct adapter, followed by other providers based on real user demand.

---

# Launch Schedule

## Friday — Planning Foundation

Target:

```text
L001 → L008
```

By the end of Friday:

```text
repo + user goal
→ analyze
→ readiness
→ discovery if needed
→ roadmap
→ mini tasks
→ validated DAG
```

The priority is correctness of generated tasks, not beautiful CLI output.

## Saturday — Complete Product Loop + Dogfood

Target:

```text
L009 → L013
```

By the end of Saturday both flows should work with real agents:

```text
defined project
→ analyze
→ plan
→ approve
→ run
→ DONE
```

and:

```text
empty repo
→ discovery
→ plan
→ approve
→ run
→ working project
```

## Sunday — Release Only

Target:

```text
L014 → L016
```

Sunday should contain:

- CLI polish
- documentation
- release verification
- clean install test
- final real-agent smoke
- publish

Avoid new architecture or feature work on release day unless required to resolve a genuine blocker.

---

# Release Positioning

## Agentic Dev Runner 0.1 — Technical Preview

Agentic Dev Runner turns software projects into bounded engineering task graphs and executes them autonomously across AI coding agents.

Give it a well-defined specification and it can decompose the work into small tasks. Give it an incomplete or empty project and it can identify missing decisions, plan the project with you, and produce an executable roadmap.

Once the roadmap is approved, Agentic Dev Runner handles scheduling, model routing, isolated Git worktrees, verification, retries, crash recovery, and controlled integration.

## Product Identity

The current engine already proves:

> Give Agentic Dev Runner a good task DAG and it can execute it reliably.

This launch sprint completes the stronger product:

> Give Agentic Dev Runner a sufficiently defined repository and goal. It will build a bounded engineering plan with you, decompose it into mini tasks, route those tasks cost-effectively, and execute the approved roadmap reliably.

## North Star

> Reliable hands-free execution of a bounded engineering roadmap, using the cheapest capable model for each task without sacrificing verification, recoverability, or developer control.
