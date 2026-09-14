# Agentic Dev Runner — Project Specification

## Purpose

Agentic Dev Runner is a local-first, open-source orchestration system for reliable autonomous software development.

It takes a sufficiently defined software project, decomposes it into bounded engineering tasks, and executes those tasks through interchangeable AI coding agents.

The system prioritizes reliability, reviewability, recoverability, and cost efficiency over maximum autonomy.

## Core Principle

The project is persistent.

Individual agent sessions are disposable.

Persistent knowledge lives in:

- project specifications
- architecture documents
- ADRs
- AGENTS.md
- task definitions
- runtime state
- Git history
- verification evidence

Each task receives a fresh, task-specific context.

## Primary User

The initial target user is an experienced software developer or small engineering team that:

- works with Git
- is comfortable with CLI tooling
- uses AI coding agents
- has an existing software project or reasonably defined specification
- wants autonomous execution without sacrificing control or reviewability

## Primary Workflow

A developer should eventually be able to run:

```bash
agentic init
agentic analyze
agentic plan
agentic run --parallel 3
agentic status
```

The runner:

1. analyzes the project
2. determines whether sufficient context exists
3. requests missing decisions when necessary
4. creates a bounded roadmap
5. decomposes it into small tasks
6. builds task dependencies
7. selects appropriate coding agents
8. executes tasks in isolated Git worktrees
9. verifies changes
10. reviews changes where required
11. integrates successful work
12. persists project state
13. continues with newly unlocked tasks

## Product Invariants

### Runner Owns State

Agents cannot directly determine authoritative task or project state.

### Runner Owns Scope

Agents cannot silently expand the roadmap or invent unrelated work.

### Verification Determines Completion

Agent claims such as "done" or "tests pass" are not authoritative.

Completion requires configured verification evidence.

### Small Tasks

A task should represent one independently reviewable capability.

Tasks should avoid unrelated changes and broad refactoring.

### Fresh Context

Each task starts with a fresh agent context containing only the information required to perform that task safely.

### Provider Agnostic

The orchestration engine must not depend on any single model or coding agent.

### Local First

Project source code, orchestration state, credentials, worktrees, and logs remain local by default.

### Recoverable

The runner must survive interruption and resume from durable state.

### Safe Parallelism

Tasks run concurrently only when dependencies, resource ownership, and integration safety permit it.

### Cross Platform

macOS, Linux, and Windows are first-class supported platforms.

### Headless Core

The orchestration engine must remain independent of its user interface.

CLI, future GUI, and future APIs must use the same application layer.

## Task Execution Model

A normal engineering task follows:

```text
PLAN
→ PLAN REVIEW
→ IMPLEMENT
→ CODE REVIEW
→ VERIFY
→ INTEGRATE
→ DONE
```

Workflow rigor may be reduced or increased depending on task type and risk.

The runner controls all workflow transitions.

## Project Readiness

Projects may contain complete specifications or only partial context.

Before autonomous implementation, the runner evaluates readiness.

If important information is missing, it enters a discovery process and asks targeted questions.

The system may propose defaults but must not silently invent important product or architectural decisions.

Implementation begins only when the project is sufficiently defined.

## Bounded Scope

Autonomous work operates against a finite roadmap.

Every task must have explicit provenance, such as:

- roadmap acceptance criterion
- user request
- discovered blocker
- verification failure
- approved task decomposition

The runner must not continuously create speculative "useful" tasks.

## Agent Routing

Different agents may be used for different work.

Routing may consider:

- task complexity
- risk
- specialization
- context requirements
- cost
- speed
- capabilities
- previous task performance

V0.1 uses deterministic rule-based routing.

Adaptive routing based on historical performance is a future capability.

## Git Isolation

Concurrent tasks must not share a working tree.

The preferred execution model is:

```text
Task
→ task branch
→ isolated Git worktree
→ implementation
→ verification
→ integration
```

A task is not complete merely because its worktree passes verification.

It becomes complete only after successful integration.

## Security

The runner must treat coding agents as untrusted execution workers.

Important protections include:

- explicit filesystem scope
- command execution policy
- secrets protection
- bounded retries
- human approval gates
- isolation between concurrent tasks
- audit history

Agent instructions alone are not considered sufficient security enforcement.

## Observability

The user should always be able to determine:

- project progress
- milestone progress
- task states
- currently running work
- blocked tasks
- agent assignments
- attempts
- verification results
- token usage where available
- cost where available
- duration
- Git commits
- failure reasons

## V0.1 Goal

V0.1 proves reliable execution of a bounded engineering roadmap.

It must support:

- existing local Git projects
- project documentation ingestion
- project readiness analysis
- bounded task planning
- durable task state
- isolated worktrees
- interchangeable agent adapters
- fresh task contexts
- verification
- atomic integration
- crash recovery
- basic scheduling
- basic routing
- progress reporting

## V0.1 Non-Goals

V0.1 does not require:

- GUI
- cloud orchestration
- distributed workers
- marketplace
- learned model routing
- team dashboards
- Figma ingestion
- Jira integration
- Linear integration
- automatic deployment
- sophisticated ETA prediction
- fully autonomous product design

## Initial Vertical Slice

Before implementing the full V0.1 roadmap, the first system milestone is:

> Execute one manually defined engineering task from start to finish.

The system must be able to:

```text
load task
→ persist task state
→ create isolated worktree
→ construct fresh context
→ invoke one coding agent
→ inspect resulting change
→ run verification
→ create an atomic commit
→ integrate the change
→ persist DONE
```

This vertical slice establishes the execution foundation before planning, multi-agent routing, discovery, and parallelism are added.

## Success Definition

Agentic Dev Runner succeeds when a developer can leave a bounded software roadmap running unattended and later return to:

- small understandable commits
- verified changes
- durable project state
- clear failures
- controlled costs
- no uncontrolled scope expansion
- complete execution history