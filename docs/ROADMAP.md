# Agentic Dev Runner V0.1 Roadmap

## M1 — Foundation

**Complete when:** project builds cross-platform and core boundaries exist.

- M001 — Initialize pnpm TypeScript workspace
- M002 — Define core domain types
- M003 — Define shared error/result model
- M004 — Add application-service layer
- M005 — Create CLI shell
- M006 — Add structured logging

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
- M019 — Implement readiness analysis
- M020 — Generate missing-context questions
- M021 — Persist user decisions
- M022 — Generate bounded milestones
- M023 — Generate small tasks
- M024 — Build/validate dependency DAG
- M025 — Detect oversized tasks
- M026 — Validate task provenance

---

## M4 — Agent Runtime

**Complete when:** two different coding agents can execute normalized jobs.

- M027 — Define AgentAdapter contract
- M028 — Define capability profiles
- M029 — Add process execution abstraction
- M030 — Add timeout/cancellation handling
- M031 — Add structured-output validation
- M032 — Implement OpenCode adapter
- M033 — Implement second agent adapter
- M034 — Record token/cost telemetry

---

## M5 — Context Engine

**Complete when:** every invocation receives a fresh task-specific context pack.

- M035 — Define ContextPack schema
- M036 — Build mandatory context collector
- M037 — Add source-file relevance discovery
- M038 — Add contract/ADR relevance discovery
- M039 — Build context manifests
- M040 — Support agent context requests
- M041 — Add context-size/token limits

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
- M064 — Add agent fallback/escalation
- M065 — Enforce parallelism limits
- M066 — Continue independent work after failures

---

## M9 — CLI Product Experience

**Complete when:** the MVP is actually usable.

- M067 — `agentic init`
- M068 — `agentic analyze`
- M069 — `agentic plan`
- M070 — `agentic tasks`
- M071 — `agentic run`
- M072 — `agentic status`
- M073 — `agentic inspect`
- M074 — `agentic retry`
- M075 — `agentic pause/resume`
- M076 — `agentic agents`
- M077 — `agentic cost`
- M078 — `agentic doctor`

---

## M10 — Release Hardening

**Complete when:** V0.1 can be trusted on a real project.

- M079 — Windows validation
- M080 — macOS validation
- M081 — Linux validation
- M082 — Forced-crash recovery tests
- M083 — Parallel execution stress test
- M084 — Provider failure tests
- M085 — Run a real 20+ task project
- M086 — Documentation/install guide
- M087 — Package V0.1 release

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