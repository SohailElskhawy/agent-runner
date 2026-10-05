# Agentic Dev Runner — Task Schema

## Purpose

A task represents one bounded, independently reviewable engineering capability.

A task is not an agent prompt, conversation, or mini-project.

## Required Fields

```yaml
id: M024
title: Restore authentication session at startup

milestone: authentication
status: ready
priority: P0
risk: low
type: implementation

objective: >
  Restore the persisted authentication session when the application starts.

acceptance_criteria:
  - Persisted session is restored before protected routing executes
  - Invalid session data results in an unauthenticated state
  - Existing authentication storage is reused

depends_on:
  - M021
  - M022

provenance:
  kind: roadmap_criterion
  source: AUTH-03

scope:
  allowed_paths:
    - src/features/auth/**
    - src/hooks/**
  forbidden_paths:
    - backend/**
    - database/**

resources:
  - auth-state

workflow: default

routing:
  complexity: small
  capabilities:
    - typescript
    - react-native

verification:
  required:
    - typecheck
    - unit

limits:
  max_attempts: 3
  max_review_cycles: 2

approval:
  required: false
```

## Task Identity

`id` must be stable and unique within the project.

Task IDs must not be reused after deletion, cancellation, or completion.

## Task Types

V0.1 supports:

```text
implementation
bugfix
refactor
test
documentation
spike
```

A spike produces knowledge or a technical decision rather than production functionality.

## Status

Task definitions may declare their initial status.

Runtime state is authoritative after execution begins.

Supported task states are defined by the orchestration state machine.

`agentic approve` and `agentic retry` are runner-controlled transitions; agents cannot perform them. Retry is legal from `FAILED`, `NEEDS_HUMAN`, and `BLOCKED` only.

## Objective

The objective should describe one capability.

Bad:

```text
Build authentication
```

Good:

```text
Restore the persisted authentication session during application startup.
```

## Acceptance Criteria

Acceptance criteria define observable completion conditions.

Each criterion should be independently understandable and verifiable where practical.

Avoid vague criteria such as:

```text
Works correctly
Clean implementation
Handles edge cases
```

Prefer:

```text
Invalid persisted session data results in an unauthenticated state without crashing.
```

## Dependencies

`depends_on` contains task IDs that must reach `DONE` before the task becomes runnable.

V0.1 uses one dependency type.

Dependency graphs must be acyclic.

## Provenance

Every task must explain why it exists.

Supported provenance kinds:

```text
roadmap_criterion
user_request
blocker
verification_failure
task_split
```

Tasks without valid provenance must not enter execution.

## Scope

### Allowed Paths

Paths the implementation may modify.

### Forbidden Paths

Paths that must not be changed.

After implementation, the runner compares the Git diff against task scope.

Unexpected changes are treated as scope violations.

An agent may request scope expansion but may not approve it itself.

## Resources

Resources represent logical areas that may conflict even when Git files do not.

Examples:

```text
auth-state
database-schema
api-contract
routing
package-lock
payments
```

The scheduler may use exclusive resource locks to prevent unsafe concurrent execution.

## Workflow

The workflow defines required execution stages.

Initial values may include:

```text
simple
default
security-critical
```

Workflow definitions belong to the workflow engine rather than individual tasks.

## Risk

Recommended V0.1 values:

```text
low
medium
high
critical
```

Risk may influence:

- workflow rigor
- model routing
- approvals
- verification
- parallel execution

## Complexity

Recommended values:

```text
trivial
small
medium
large
```

`large` should normally trigger task-size review before execution.

Complexity is a routing/planning hint, not an engineering-time guarantee.

Generated plans use the same task contract as `agentic tasks add`. Before a
plan can be approved, the runner validates all task fields, provenance,
milestones, dependencies, cycles, configured verification names, ID collisions,
and plan size. A task above medium complexity, with more than five acceptance
criteria, or with more than eight allowed paths must be split before approval;
there is no runtime `SPLIT_REQUIRED` task state.

## Routing Requirements

Tasks should describe required capabilities rather than naming a specific provider whenever possible.

Agent profiles may declare a relative `tier` in project configuration:

```yaml
agents:
  profiles:
    economical-coder:
      adapter: opencode
      tier: economy # economy | standard | strong; omitted means standard
      capabilities: [typescript]
```

V0.1 chooses the cheapest available profile that satisfies both the task's
capabilities and its minimum tier. Large or high/critical work requires
`strong`, medium work requires `standard`, and other work requires `economy`.
Every failed attempt raises the minimum by one tier, capped at `strong`,
without increasing `limits.max_attempts`. If no profile meets the floor, the
runner reports the routing failure instead of silently downgrading.

Prefer:

```yaml
routing:
  capabilities:
    - typescript
    - debugging
```

over:

```yaml
agent: codex
```

Explicit agent assignment may still be supported as an override.

## Verification

Tasks declare required verification categories or named project checks.

Examples:

```yaml
verification:
  required:
    - typecheck
    - unit
    - auth-integration
```

Checks that are not listed in `verification.required` are not run. Waiving a check is expressed by omission; v0.1 has no per-check opt-out syntax.

## Limits

Tasks must have bounded execution limits.

Typical limits include:

```yaml
limits:
  max_attempts: 3
  max_review_cycles: 2
```

Additional runtime limits may be inherited from project configuration.

Attempt budget: `agentic retry` refuses to return a task to READY when the recorded attempts reached `limits.max_attempts`.

## Human Approval

Tasks may explicitly require human approval:

```yaml
approval:
  required: true
  reason: Database migration changes persistent production data.
```

Project policy may also impose approval regardless of task configuration.

V0.1 approval semantics:

- `agentic plan approve <plan-id>` revalidates an editable draft and imports its tasks plus durable plan approval atomically; unapproved drafts cannot be scheduled.
- `agentic approve <task-id>` records a durable approval grant for the task.
- Approval-required tasks stay unrunnable by the unattended scheduler until the grant exists; `agentic retry` is refused for them until then.
- The grant survives failure and retry; it is not cleared when a task fails or returns to `READY`.
- An explicit `agentic run <task-id>` is the human's direct instruction and is not blocked by `approval.required`; the approval gate applies to scheduler selection.

## Oversized Task Detection

Whole-plan validation rejects tasks above medium complexity, with over five
acceptance criteria, or with over eight allowed paths and asks that they be
split. V0.1 does not create a `SPLIT_REQUIRED` runtime state.

## Task vs Attempt

Execution history must not be stored inside the canonical task definition.

The runtime persistence layer stores attempts separately.

Example:

```text
M042
├─ attempt 1 → failed
├─ attempt 2 → timeout
└─ attempt 3 → passed
```

## Completion

A task does not become `DONE` because:

- an agent says it is complete
- code was generated
- the isolated worktree passes tests

A task becomes `DONE` only after all required workflow gates and successful integration are complete.

## Design Principle

A valid task should answer five questions clearly:

1. What single capability is required?
2. Why does this task exist?
3. What may it change?
4. What must happen before it runs?
5. What evidence proves it is complete?
