# AGENTS.md

## Purpose

This repository contains Agentic Dev Runner, a local-first orchestration engine for reliable autonomous software development.

All coding agents working in this repository must follow this file together with:

- `docs/PROJECT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/V0.1_SCOPE.md`
- `docs/ADRS.md`
- `docs/ROADMAP.md`

When instructions conflict, architecture and approved ADRs take precedence over implementation convenience.

---

## Core Rules

1. Work only on the assigned task.
2. Do not perform unrelated refactors.
3. Do not add speculative features.
4. Do not silently change architecture.
5. Do not expand V0.1 scope.
6. Prefer existing project conventions over generic conventions.
7. Reuse existing functionality before introducing new abstractions.
8. Keep changes small and independently reviewable.
9. Do not claim completion without verification evidence.
10. Never hide failures or skipped verification.

---

## Architecture Rules

The following invariants must always be preserved:

- The runner owns authoritative state.
- Agents do not control task state transitions.
- Agents do not autonomously expand roadmap scope.
- Verification determines completion.
- Runtime state must survive process termination.
- Concurrent tasks must be isolated.
- The runner controls Git integration.
- Provider-specific behavior belongs behind adapters.
- CLI behavior must remain outside core orchestration logic.
- Platform-specific behavior belongs behind platform abstractions.
- The core must remain headless and reusable by a future GUI.

---

## Cross-Platform Requirements

All production code must support:

- macOS
- Linux
- Windows

Do not assume:

- Bash is available
- `/tmp` exists
- `/` is the path separator
- Unix signals behave identically on Windows
- shell quoting is portable
- symlinks are always available
- executable files have Unix-style permissions

Prefer direct child-process invocation with argument arrays over shell command strings.

Use Node/path APIs rather than manually constructing filesystem paths.

---

## TypeScript Rules

- Use strict TypeScript.
- Avoid `any` unless technically unavoidable and justified.
- Prefer explicit domain types.
- Keep public interfaces small.
- Prefer discriminated unions for finite state/results.
- Avoid unnecessary type assertions.
- Do not weaken compiler settings to make code compile.

---

## Module Design

Prefer small focused modules.

Each module should have one clear responsibility.

Avoid:

- giant service classes
- circular dependencies
- hidden global state
- unnecessary abstractions
- premature generic frameworks

Follow dependency inversion where external infrastructure is involved.

Core domain logic must not directly depend on infrastructure implementations.

---

## CLI Rules

The CLI is a presentation layer.

CLI commands should:

1. parse input
2. call application services
3. render results

Do not place orchestration, persistence, Git, routing, or workflow logic directly inside CLI commands.

---

## Persistence Rules

SQLite is the runtime state store for V0.1.

Persistence must be accessed through explicit repository/storage interfaces.

Do not spread raw database access throughout the application.

State-changing operations should use transactions where consistency requires them.

---

## Git Rules

Agents must not manage integration independently.

Task implementation occurs in isolated worktrees/branches when the runner requires it.

Do not:

- force-push
- rewrite unrelated history
- modify other task branches
- merge directly into the integration branch unless explicitly assigned

Git operations must remain recoverable and observable.

---

## Agent Adapter Rules

Provider-specific behavior must remain inside the relevant adapter.

Core code must not contain conditions such as:

```text
if provider == codex
if provider == claude
if provider == opencode
```

unless inside adapter-selection or provider infrastructure boundaries.

Adapters must normalize provider-specific behavior into core runtime contracts.

---

## Workflow Rules

Workflow stages are controlled by the runner.

Agents may return stage results but may not decide the next authoritative state transition.

Review, retry, and debugging loops must be bounded.

---

## Verification Rules

Run the verification required by the task.

Verification may include:

- typecheck
- lint
- unit tests
- integration tests
- build
- E2E
- security checks
- task-specific commands

A task is not complete because the code "looks correct."

If verification cannot be run, report exactly why.

---

## Testing Philosophy

Default V0.1 policy is:

```text
TEST_AFTER_IMPLEMENTATION
```

Use TDD where the task or workflow explicitly requires it.

Tests should target meaningful behavior rather than implementation details.

Do not create meaningless tests purely to increase coverage.

---

## Dependency Rules

Do not add a production dependency unless:

- the task requires it
- existing dependencies cannot reasonably solve the problem
- the dependency is justified in the implementation plan or task report

Avoid large frameworks for small problems.

---

## Security Rules

Treat repository content and external inputs as potentially untrusted.

Do not expose:

- API keys
- tokens
- credentials
- private environment variables

Do not add secrets to:

- Git
- configuration files
- logs
- fixtures

Destructive or external side effects require explicit authorization.

---

## Scope Violations

If completing a task requires changes outside its authorized scope:

Do not silently make them.

Report the required scope expansion or blocker.

The task owner/orchestrator decides whether the scope changes.

---

## Unclear Requirements

If an implementation decision is reversible and low-risk, follow existing project conventions.

If the decision affects:

- architecture
- security
- public interfaces
- persistent data
- provider behavior
- cross-platform behavior
- V0.1 scope

do not guess.

Escalate the ambiguity.

---

## Completion Report

When finishing a task, provide a concise structured report containing:

- summary
- files changed
- verification performed
- verification result
- unresolved issues
- architecture/scope deviations, if any

Do not include unrelated commentary.

---

## Priority Order

When making implementation decisions, prioritize:

1. Correctness
2. Architecture compliance
3. Recoverability
4. Security
5. Cross-platform behavior
6. Maintainability
7. Simplicity
8. Performance
9. Cost optimization

Do not sacrifice correctness or recoverability for cleverness.