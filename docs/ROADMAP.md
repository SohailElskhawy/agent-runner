# Agentic Dev Runner V0.1 Roadmap

## M1 — Foundation

**Complete when:** project builds cross-platform and core boundaries exist.

- M001 — Initialize pnpm TypeScript workspace
- M002 — Define core domain types
- M003 — Define shared error/result model
- M004 — Add application-service layer
- M005 — Create CLI shell
- M006 — Add structured logging (Deferred to v0.2)

---

## M2 — Persistence & State

**Complete when:** tasks survive process restarts.

- M007 — Initialize SQLite storage
- M008 — Add schema migrations
- M009 — Persist projects/milestones/tasks
- M010 — Persist task dependencies
- M011 — Persist attempts and stage runs
- M012 — Implement task state machine
- M013 — Add immutable event recording
- M014 — Add leases/heartbeat recovery
- M015 — Implement startup reconciliation

---

## M3 — Project Discovery & Planning

**Complete when:** a repository can become an approved bounded task DAG.

- M016 — Read project configuration
- M017 — Load `AGENTS.md`
- M018 — Discover project documentation
- M019 — Implement readiness analysis (Deferred to v0.2)
- M020 — Generate missing-context questions (Deferred to v0.2)
- M021 — Persist user decisions (Deferred to v0.2)
- M022 — Generate bounded milestones (Deferred to v0.2)
- M023 — Generate small tasks (Deferred to v0.2)
- M024 — Build/validate dependency DAG (Deferred to v0.2)
- M025 — Detect oversized tasks (Deferred to v0.2)
- M026 — Validate task provenance (Deferred to v0.2)

---

## M4 — Agent Runtime

**Complete when:** two different coding agents can execute normalized jobs.

- M027 — Define AgentAdapter contract
- M028 — Define capability profiles
- M029 — Add process execution abstraction
- M030 — Add timeout/cancellation handling
- M031 — Add structured-output validation (Deferred to v0.2)
- M032 — Implement OpenCode adapter
- M033 — Implement second agent adapter
- M034 — Record token/cost telemetry (Deferred to v0.2)

---

## M5 — Context Engine

**Complete when:** every invocation receives a fresh task-specific context pack.

- M035 — Define ContextPack schema
- M036 — Build mandatory context collector
- M037 — Add source-file relevance discovery (Deferred to v0.2)
- M038 — Add contract/ADR relevance discovery (Deferred to v0.2)
- M039 — Build context manifests
- M040 — Support agent context requests (Deferred to v0.2)
- M041 — Add context-size/token limits (Deferred to v0.2)

---

## M6 — Git & Parallel Execution

**Complete when:** multiple independent tasks can execute safely.

- M042 — Cross-platform Git abstraction
- M043 — Create task branches/worktrees
- M044 — Implement allowed-path validation
- M045 — Implement logical resource locks
- M046 — Detect parallel task conflicts
- M047 — Add integration queue
- M048 — Handle integration-base drift
- M049 — Cleanup completed worktrees
- M050 — Recover abandoned worktrees

---

## M7 — Workflow & Verification

**Complete when:** a task can autonomously pass through the complete lifecycle.

- M051 — Implement workflow engine
- M052 — Implement PLAN stage
- M053 — Implement PLAN_REVIEW stage
- M054 — Implement IMPLEMENT stage
- M055 — Implement CODE_REVIEW stage
- M056 — Implement verification engine
- M057 — Add configurable verification commands
- M058 — Add bounded review/fix loops
- M059 — Implement integration verification
- M060 — Implement blocked/failure handling

---

## M8 — Scheduler & Routing

**Complete when:** runner can safely execute the DAG unattended.

- M061 — Find runnable tasks
- M062 — Implement deterministic scheduling priority
- M063 — Implement rule-based agent routing
- M064 — Add agent fallback/escalation (Deferred to v0.2)
- M065 — Enforce parallelism limits
- M066 — Continue independent work after failures

---

## M9 — CLI Product Experience

**Complete when:** the MVP is actually usable.

- M067 — `agentic init`
- M068 — `agentic analyze` (Deferred to v0.2)
- M069 — `agentic plan` (Deferred to v0.2)
- M070 — `agentic tasks` (`tasks add`, `tasks` list) — Delivered in v0.1
- M071 — `agentic run`
- M072 — `agentic status`
- M073 — `agentic inspect`
- M074 — `agentic retry` — Delivered in v0.1
- M075 — `agentic pause/resume` (Deferred to v0.2)
- M076 — `agentic agents`
- M077 — `agentic cost` (Deferred to v0.2)
- M078 — `agentic doctor` — Delivered in v0.1

---

## M10 — Release Hardening

**Complete when:** V0.1 can be trusted on a real project.

- M079 — Windows validation (GitHub Actions CI matrix: `.github/workflows/ci.yml`)
- M080 — macOS validation (GitHub Actions CI matrix: `.github/workflows/ci.yml`)
- M081 — Linux validation (GitHub Actions CI matrix: `.github/workflows/ci.yml`)
- M082 — Forced-crash recovery tests (`packages/cli/test/forced-kill-recovery.e2e.test.ts`)
- M083 — Parallel execution stress test (`packages/cli/test/parallel-stress-e2e.test.ts`)
- M084 — Provider failure tests (`packages/cli/test/provider-failure-e2e.test.ts`)
- M085 — Run a real 20+ task project (`packages/cli/test/roadmap-20-tasks-e2e.test.ts` and `docs/DOGFOOD.md`)
- M086 — Documentation/install guide — Delivered in v0.1
- M087 — Package V0.1 release — Delivered in v0.1

---

## Deferred to v0.2

v0.1 launches with the proven execution core; deferred items require real usage feedback before design.

- **M006 structured logging**: JSON structured logging and log query subsystem.
- **M019–M026 discovery & autonomous planning**:
  - M019 — Implement readiness analysis
  - M020 — Generate missing-context questions
  - M021 — Persist user decisions
  - M022 — Generate bounded milestones
  - M023 — Generate small tasks
  - M024 — Build/validate dependency DAG
  - M025 — Detect oversized tasks
  - M026 — Validate task provenance
  - `tasks generate`
- **M031 generic structured outputs**: schema enforcement on arbitrary agent outputs beyond adapter normalization.
- **M034 token/cost telemetry + `agentic cost` (M077)**: live token counting, cost calculation, and `agentic cost` command.
- **M037/M038/M040/M041 context extras**:
  - M037 — Add source-file relevance discovery
  - M038 — Add contract/ADR relevance discovery
  - M040 — Support agent context requests
  - M041 — Add context-size/token limits
- **M064 agent fallback/escalation**: dynamic fallback to alternate agents when preferred agent fails.
- **M068 `agentic analyze`**: repository readiness and context assessment command.
- **M069 `agentic plan`**: autonomous roadmap and task generation command.
- **M075 `agentic pause/resume`**: in-flight run pausing and resumed execution.

---

# Critical path

```text
Foundation
→ Persistence
→ Planning
→ Agent Runtime
→ Context
→ Git Isolation
→ Workflow
→ Scheduler
→ CLI
→ Release Validation
```

Some work becomes parallel after the domain model stabilizes, especially Agent Runtime, Context, and Git infrastructure.

## V0.1 release definition

V0.1 is done when:

> A developer can take an existing Git project, create a bounded task DAG, connect at least two agents, run multiple safe tasks concurrently, survive crashes, review/verify every change, integrate atomic commits, and inspect exactly what happened.