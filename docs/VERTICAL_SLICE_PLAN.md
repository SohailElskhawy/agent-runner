# Agentic Dev Runner — First Vertical Slice

## Goal

Prove the core execution loop:

```text
manual task
→ persisted state
→ isolated worktree
→ context pack
→ one agent
→ code change
→ verification
→ commit
→ integration
→ DONE
```

No autonomous planning, routing, parallelism, or discovery yet.

## VS001 — Initialize Workspace

Create:

- pnpm workspace
- TypeScript configuration
- package structure
- Vitest
- lint/typecheck scripts

Acceptance:

- repository installs
- typecheck passes
- tests run on Windows/macOS/Linux-compatible configuration

---

## VS002 — Core Domain Types

Implement core types for:

- Project
- Task
- Attempt
- TaskStatus
- StageRun
- VerificationResult

Depends on: VS001

Acceptance:

- strict TypeScript
- no infrastructure dependencies

---

## VS003 — Task State Machine

Implement legal transitions such as:

```text
READY
→ IMPLEMENTING
→ VERIFYING
→ INTEGRATING
→ DONE
```

Also:

```text
BLOCKED
FAILED
CANCELLED
```

Depends on: VS002

Acceptance:

- invalid transitions rejected
- transitions unit-tested

---

## VS004 — SQLite Persistence

Persist:

- project
- task
- attempt
- current task state
- events

Depends on: VS002

Acceptance:

- state survives process restart
- transactions protect state transitions

---

## VS005 — Process Runner

Create cross-platform child-process abstraction.

Support:

- command + argument arrays
- stdout/stderr capture
- exit code
- timeout
- cancellation

Depends on: VS001

Acceptance:

- no Bash dependency
- works with paths containing spaces

---

## VS006 — Git Manager

Implement:

- repository validation
- branch creation
- worktree creation
- diff inspection
- commit creation
- worktree cleanup

Depends on: VS005

Acceptance:

- task gets isolated branch/worktree
- Git commands do not use shell-string construction

---

## VS007 — Context Pack

Build a minimal ContextPack containing:

- task
- AGENTS.md
- relevant project docs
- authorized paths
- base commit

Depends on: VS002

Acceptance:

- deterministic manifest records everything included

---

## VS008 — Agent Runtime Interface

Define provider-independent invocation interface.

Support:

- start
- result collection
- timeout
- cancellation
- normalized result

Depends on: VS002, VS005

Acceptance:

- core contains no provider-specific logic

---

## VS009 — First Agent Adapter

Implement one real adapter, preferably OpenCode or whichever CLI we choose for initial testing.

Depends on: VS008

Acceptance:

- agent receives ContextPack
- agent runs inside task worktree
- stdout/stderr captured
- result normalized

---

## VS010 — Verification Engine

Support configured commands such as:

```text
pnpm typecheck
pnpm test
```

Depends on: VS005

Acceptance:

- command results persisted
- failure prevents integration

---

## VS011 — Single-Task Orchestrator

Implement:

```text
load task
→ create attempt
→ create worktree
→ build context
→ invoke agent
→ inspect diff
→ verify
→ commit
→ integrate
→ DONE
```

Depends on:

- VS003
- VS004
- VS006
- VS007
- VS009
- VS010

Acceptance:

- orchestrator owns every state transition
- agent cannot mark task DONE

---

## VS012 — Minimal CLI

Add:

```bash
agentic init
agentic run <task-id>
agentic status
agentic inspect <task-id>
```

Depends on: VS011

Acceptance:

- CLI only calls application services
- no orchestration logic inside CLI commands

---

## VS013 — Crash Recovery

Test interruption during:

- agent execution
- verification
- integration

Depends on: VS011

Acceptance:

- restart does not corrupt state
- runner reconciles unfinished operations
- no duplicate integration

---

## VS014 — Real End-to-End Test

Use Agentic Dev Runner on a small fixture repository.

Task example:

> Add a small validated utility function with tests.

Validate:

- isolated worktree created
- agent modifies code
- verification passes
- atomic commit produced
- integration succeeds
- task becomes DONE
- full history remains inspectable

Depends on: VS012, VS013

## Vertical Slice Complete When

One real coding agent can successfully execute one manually defined task end-to-end with durable state, Git isolation, verification, integration, and crash recovery.