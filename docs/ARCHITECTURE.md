# Agentic Dev Runner — Architecture

## 1. Architectural Goal

Agentic Dev Runner is a local-first orchestration engine for autonomous software development.

Its architecture must remain:

- deterministic
- resumable
- provider-agnostic
- cross-platform
- headless
- observable
- safe for parallel execution
- extensible to a future GUI

The orchestration engine owns workflow state and project execution.

AI agents are replaceable workers.

---

## 2. High-Level Architecture

```text
CLI ─────────────┐
Future GUI ──────┼──→ Application Layer
Future API ──────┘          │
                            ▼
                     Core Orchestrator
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    Scheduler          Workflow Engine       Router
        │                   │                   │
        └──────────────┬────┴──────────────┬────┘
                       ▼                   ▼
                 Context Engine       Agent Runtime
                                             │
                                   Provider Adapters
                                   ├─ OpenCode
                                   ├─ Codex
                                   └─ future agents

        ┌──────────────────────────────────────────┐
        │ Supporting Infrastructure                │
        │                                          │
        │ Git Manager                              │
        │ Verification Engine                      │
        │ Discovery / Readiness                    │
        │ Persistence                              │
        │ Event System                             │
        │ Platform Abstraction                     │
        └──────────────────────────────────────────┘
```

---

## 3. Architectural Layers

### Presentation Layer

Initial implementation:

- CLI

Future implementations may include:

- desktop GUI
- browser GUI
- local API
- remote management interface

Presentation layers must not contain orchestration business logic.

They interact with the system through the application layer.

---

### Application Layer

Provides use cases such as:

```text
initializeProject()
analyzeProject()
createRoadmap()
startRun()
pauseRun()
resumeRun()
retryTask()
getProjectStatus()
inspectTask()
```

The CLI and future GUI both use these same operations.

---

### Core Domain

Contains provider-independent business concepts:

- Project
- Milestone
- Task
- TaskDependency
- Attempt
- StageRun
- AgentProfile
- Workflow
- ContextPack
- VerificationRun
- Approval
- Integration
- ResourceLock
- Event

The core must not depend directly on:

- oclif
- SQLite implementation details
- Codex
- OpenCode
- operating-system shell behavior
- GUI frameworks

---

## 4. Orchestrator

The orchestrator controls task execution.

Responsibilities:

- enforce task state transitions
- execute workflow stages
- create attempts
- enforce retries
- request approvals
- invoke supporting services
- persist results
- recover interrupted work

The orchestrator must remain deterministic.

AI models must never control orchestration state directly.

---

## 5. Task State Model

Primary lifecycle:

```text
BACKLOG
→ READY
→ PLANNING
→ PLAN_REVIEW
→ IMPLEMENTING
→ CODE_REVIEW
→ VERIFYING
→ INTEGRATING
→ DONE
```

Additional states:

```text
BLOCKED
NEEDS_HUMAN
FAILED
CANCELLED
```

Only the orchestrator may perform authoritative state transitions.

---

## 6. Task vs Attempt

A Task represents required project work.

An Attempt represents one execution of that task.

Example:

```text
Task M042
├─ Attempt 1 → OpenCode → failed
├─ Attempt 2 → OpenCode → timeout
└─ Attempt 3 → Codex → successful
```

Attempts store:

- agent
- model
- context manifest
- base revision
- timings
- logs
- token usage
- cost
- stage results
- failure information

---

## 7. Scheduler

The scheduler determines which tasks may run.

A task is runnable when:

```text
status == READY
AND dependencies are DONE
AND approvals are satisfied
AND required resources are available
AND parallelism capacity exists
AND an eligible agent exists
```

The scheduler must not create tasks or expand roadmap scope.

---

## 8. Agent Router

The router selects an eligible agent for a stage or task.

V0.1 routing is deterministic.

Inputs may include:

- task type
- complexity
- risk
- required capabilities
- estimated context size
- cost policy
- configured agent availability

Historical adaptive routing is deferred.

---

## 9. Agent Runtime

The orchestrator communicates with agents through a provider-independent runtime interface.

Adapters may represent:

- CLI agents
- API agents
- locally hosted models
- future remote workers

Each adapter declares supported capabilities.

Possible capabilities include:

```text
structured_output
streaming
cancellation
token_reporting
cost_reporting
multimodal
interactive_session
sandboxing
```

Provider-specific behavior must stay inside adapters.

---

## 10. Workflow Engine

A workflow determines which execution stages a task requires.

Default workflow:

```text
PLAN
→ PLAN_REVIEW
→ IMPLEMENT
→ CODE_REVIEW
→ VERIFY
→ INTEGRATE
```

Other workflows may reduce or increase rigor.

Examples:

```text
simple
security-critical
rapid-prototype
```

Workflow execution must remain bounded.

Review and retry cycles must have configured limits.

---

## 11. Context Engine

Each agent invocation receives a fresh ContextPack.

Context is divided into:

### Mandatory Context

Examples:

- task contract
- acceptance criteria
- project rules
- relevant architecture constraints
- base revision
- allowed paths
- dependency outputs

### Retrieved Context

Examples:

- relevant source files
- tests
- symbols
- API contracts
- ADRs
- Git history

### Discovery Context

Important user decisions gathered during project readiness.

### On-Demand Context

Additional information requested during execution.

Every attempt must persist a ContextManifest describing exactly what the agent received.

---

## 12. Discovery & Readiness Engine

Before roadmap generation, the system determines whether the project is sufficiently defined.

Possible states:

```text
UNASSESSED
→ ANALYZING
→ READY_FOR_PLANNING

or

UNASSESSED
→ ANALYZING
→ NEEDS_DISCOVERY
→ DISCOVERY
→ READY_FOR_PLANNING
```

Important missing decisions must be presented to the user.

Agents may propose defaults but must not silently create authoritative product or architectural decisions.

---

## 13. Git Manager

Git operations are controlled by the runner.

Concurrent tasks use:

```text
one task
→ one branch
→ one worktree
```

Agents do not control integration.

Typical lifecycle:

```text
create worktree
→ implement
→ verify
→ create task commit
→ enter integration queue
→ synchronize with latest integration state
→ verify integration
→ merge
→ cleanup
```

A task becomes `DONE` only after successful integration.

---

## 14. Resource Locks

Git file conflicts are not sufficient to determine safe concurrency.

Tasks may declare logical resources such as:

```text
auth-state
database-schema
package-lock
routing
payments
api-contract
```

Conflicting exclusive resource locks prevent unsafe parallel execution.

---

## 15. Verification Engine

The verification engine determines what evidence is required before integration.

Verification types may include:

```text
typecheck
lint
unit
integration
e2e
build
security
custom
```

Verification requirements may come from:

- project policy
- task type
- task risk
- task-specific configuration

Agent claims are not accepted as verification evidence.

The runner executes verification itself.

---

## 16. Persistence

Runtime orchestration state is stored locally.

Preferred model:

```text
SQLite
→ authoritative orchestration state

Git
→ authoritative source history

Markdown / YAML
→ human project contracts

Structured events
→ audit history
```

Persistence implementation details must remain behind repository interfaces.

---

## 17. Event Model

Important operations emit structured events.

Examples:

```text
task.created
task.started
plan.created
plan.approved
implementation.started
implementation.completed
review.requested
review.failed
review.passed
verification.started
verification.failed
verification.passed
integration.started
integration.completed
task.blocked
task.completed
```

The CLI and future GUI consume the same state and events.

---

## 18. Crash Recovery

Execution must be durable.

Important operations follow:

```text
persist intent
→ perform action
→ inspect actual outcome
→ persist result
```

On restart, the runner reconciles persisted state with:

- Git branches
- worktrees
- commits
- running processes
- locks
- unfinished attempts

Stages are classified as:

```text
safe_to_retry
requires_reconciliation
requires_human
```

The runner must never assume an operation failed merely because the process crashed.

---

## 19. Cross-Platform Architecture

macOS, Linux, and Windows are first-class platforms.

Avoid assumptions about:

- Bash
- `/tmp`
- Unix signals
- executable extensions
- path separators
- shell quoting
- symlink availability
- file permission semantics

Platform-sensitive functionality belongs behind explicit abstractions.

Prefer direct child-process invocation over constructing shell command strings.

---

## 20. Security Boundary

Coding agents are treated as untrusted workers.

Security cannot rely only on prompting.

The runner is responsible for enforcing:

- filesystem scope
- executable policy
- environment filtering
- secrets handling
- approval requirements
- timeouts
- cancellation
- retry limits
- audit history

Execution sandboxing and Git worktree isolation are separate concerns.

---

## 21. Package Boundaries

Initial repository structure:

```text
packages/

  core/
    domain/
    orchestrator/
    scheduler/
    state-machine/
    routing/

  persistence/
    database/
    migrations/
    repositories/
    events/

  context/
    builder/
    retrieval/
    manifests/

  discovery/
    readiness/
    questioning/
    contracts/

  agents/
    runtime/
    adapters/

  workflows/
    default/
    simple/
    security-critical/

  git/
    worktrees/
    branches/
    integration/
    locks/

  verification/
    engine/
    runners/
    policies/

  platform/
    processes/
    filesystem/
    paths/

  cli/

  shared/
    schemas/
    errors/
    logging/
```

These boundaries may evolve, but dependency direction must remain clear.

---

## 22. Dependency Direction

Presentation and infrastructure depend on core abstractions.

Core must not depend on infrastructure implementations.

Conceptually:

```text
CLI / GUI
    ↓
Application
    ↓
Core Domain
    ↑
Infrastructure Adapters
```

This is required so future GUI, remote workers, alternate persistence, or new agent providers can be added without redesigning the engine.

---

## 23. Initial Vertical Slice

The first implementation target is deliberately smaller than the full V0.1 architecture.

```text
manually defined task
→ persisted state
→ isolated worktree
→ fresh ContextPack
→ one agent invocation
→ code modification
→ verification
→ task commit
→ integration
→ DONE
```

The first vertical slice does not require:

- autonomous planning
- multi-agent routing
- parallel execution
- discovery
- adaptive routing
- GUI

Those capabilities are added after the execution foundation proves reliable.

---

## 24. Architecture Invariants

All implementation must preserve these rules:

1. The runner owns authoritative state.
2. Agents cannot expand project scope autonomously.
3. Agents cannot mark themselves successful.
4. Verification evidence determines completion.
5. Runtime state must survive process termination.
6. Parallel tasks must be isolated.
7. Integration is controlled by the runner.
8. Provider-specific behavior stays behind adapters.
9. CLI-specific behavior stays outside the core.
10. Platform-specific behavior stays behind abstractions.
11. Project source remains local by default.
12. The architecture must support a future GUI without replacing the core engine.