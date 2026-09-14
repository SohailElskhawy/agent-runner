### ADR-001 — TypeScript + Node.js

**Status:** Accepted

**Decision:** Build the core platform in TypeScript running on Node.js.

**Why:** Strong typing, mature CLI/process tooling, excellent ecosystem, cross-platform support, and easy future GUI integration.

---

### ADR-002 — Headless Core

**Status:** Accepted

**Decision:** CLI, future GUI, and future APIs must all call the same application/core layer.

```text
CLI ─┐
GUI ─┼→ Application Layer → Core
API ─┘
```

No orchestration logic belongs inside the CLI.

---

### ADR-003 — Local-First Architecture

**Status:** Accepted

**Decision:** V0.1 runs entirely on the developer's machine.

Source code, credentials, state, worktrees, and logs remain local unless a configured provider requires remote model access.

---

### ADR-004 — SQLite Runtime State

**Status:** Accepted

**Decision:** SQLite is the canonical orchestration database.

Git remains canonical for source history. Markdown/YAML remain canonical for human-authored project contracts.

SQLite driver details stay behind an abstraction.

---

### ADR-005 — Durable Explicit State Machine

**Status:** Accepted

**Decision:** Task progress is represented through persisted state transitions controlled only by the orchestrator.

Agents cannot directly mark tasks completed.

---

### ADR-006 — Task and Attempt Separation

**Status:** Accepted

**Decision:** A task represents required work; an attempt represents one execution of that work.

One task may have multiple attempts using different models.

---

### ADR-007 — Worktree-per-Task Isolation

**Status:** Accepted

**Decision:** Every concurrently executing task receives its own Git branch and worktree.

The orchestrator—not the agent—controls integration.

---

### ADR-008 — Integration Determines Completion

**Status:** Accepted

**Decision:** Passing verification inside a task worktree does not make a task `DONE`.

A task becomes `DONE` only after successful integration and required integration verification.

---

### ADR-009 — Provider-Agnostic Agent Runtime

**Status:** Accepted

**Decision:** The core talks to an abstract Agent Runtime.

Provider-specific behavior for Codex, OpenCode, Claude, Gemini, local models, etc. lives behind adapters.

Adapters explicitly advertise supported capabilities.

---

### ADR-010 — Deterministic Workflow Engine

**Status:** Accepted

**Decision:** Workflow stages and gates are controlled by the runner.

Agents execute stages but cannot redesign the workflow.

V0.1 workflows are configuration-driven rather than arbitrary executable plugins.

---

### ADR-011 — Bounded Roadmap

**Status:** Accepted

**Decision:** Autonomous execution operates only within a finite approved roadmap.

Every task requires explicit provenance such as:

- roadmap criterion
- user request
- blocker
- verification failure
- approved task split

Agents cannot silently create unrelated work.

---

### ADR-012 — Context Packs Instead of Repository Dumps

**Status:** Accepted

**Decision:** Every agent invocation receives a task-specific context pack containing mandatory, retrieved, and optionally requested context.

The exact context manifest is persisted for each attempt.

---

### ADR-013 — External Verification Is Authoritative

**Status:** Accepted

**Decision:** Agent claims such as "done" or "tests pass" are informational only.

The runner determines completion using configured verification evidence.

---

### ADR-014 — Rule-Based Routing First

**Status:** Accepted

**Decision:** V0.1 uses deterministic routing rules based on task type, complexity, risk, cost, and agent capability.

Historical adaptive routing is deferred until sufficient telemetry exists.

---

### ADR-015 — Cross-Platform by Design

**Status:** Accepted

**Decision:** macOS, Linux, and Windows are first-class platforms.

Core code must avoid assumptions about:

- Bash
- Unix paths
- Unix signals
- `/tmp`
- shell quoting
- executable extensions

OS-specific behavior must live behind platform abstractions.

---

### ADR-016 — Event-Driven Observability

**Status:** Accepted

**Decision:** Important state changes produce structured immutable events.

CLI and future GUI derive live progress from the same runtime state/event system.

---

### ADR-017 — Discovery Before Planning

**Status:** Accepted

**Decision:** Projects are assessed for readiness before roadmap generation.

Missing important decisions trigger guided discovery rather than silent assumptions.

Autonomous implementation cannot begin until the project reaches `READY_FOR_PLANNING`.

---

### ADR-018 — Single Local Engine for V0.1

**Status:** Accepted

**Decision:** Start with one local orchestrator process plus child agent processes.

Do not introduce distributed workers, brokers, Redis, or microservices yet.

Architecture boundaries should allow remote workers later without redesigning the domain model.