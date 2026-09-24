# Agentic Dev Runner

Agentic Dev Runner is a local-first orchestration engine that executes a bounded engineering roadmap through interchangeable coding agents — in isolated Git worktrees, with runner-owned state, verification-gated completion, and crash-safe recovery.

- **Runner-owned state.** A deterministic state machine and SQLite runtime store own every task transition. Agents are replaceable workers and never control state.
- **Verification-gated completion.** The runner executes the configured verification checks itself; a task becomes `DONE` only after integration verification passes. Agent claims are not evidence.
- **Isolated by construction.** One task → one branch → one worktree; worktrees are created outside the repository under the local state directory.
- **Crash-safe.** Every stage persists intent before acting and reconciles the actual outcome after a restart. A crash is never treated as proof of failure.
- **Provider-agnostic.** Provider behavior lives behind adapters; v0.1 ships `opencode` and `codex`.
- **Cross-platform.** macOS, Linux, and Windows are first-class targets, with no Bash, `/tmp`, shell-quoting, or signal assumptions.

## Status: v0.1.0

What works today:

- `agentic init` creates local runner state (SQLite database plus worktrees root) for the current repository.
- Manual task ingestion from JSON with `agentic tasks add`.
- Single-task execution (`agentic run <task-id>`) through the resolved workflow, with integration verification before `DONE`.
- Unattended DAG execution (`agentic run`, `agentic run-all`) over every runnable task, with bounded parallelism via `--parallel <n>`.
- Verification checks executed by the runner in the task worktree and again on the integrated result.
- Durable attempts, events, execution claims, exclusive resource locks, and crash recovery.
- Human approval gates, retry with attempt budgets, project status, task inspection, preflight `doctor`, and local agent discovery.

Explicit limitations of v0.1.0:

- Tasks are authored manually as JSON. Autonomous planning — analysis, roadmap/milestone generation, task generation, and oversized-task detection — is v0.2.
- Token and cost telemetry are v0.2; there is no `agentic cost` command yet.
- `pause`/`resume` are v0.2. A run either continues to completion or is interrupted and recovered on the next invocation.
- Timeout and cancellation terminate the direct agent process only, not its whole process tree. A terminated agent can leave orphaned child processes behind on the host.
- The runner is local-only: one engine per machine, no remote workers, no cloud control plane, no GUI.
- macOS, Linux, and Windows are supported targets; the CI matrix runs lint, typecheck, build, and the full test suite on all three.

## Requirements

- Node.js >= 24 (the runner uses Node's built-in SQLite; Node prints an `ExperimentalWarning: SQLite is an experimental feature` on startup — this is expected)
- Git
- At least one supported coding-agent CLI installed, on `PATH`, and authenticated: `opencode` or `codex`
- A non-empty `AGENTS.md` at the repository root (it is a mandatory part of every agent context pack)
- An `agentic.yaml` file at the repository root (see [Configuration](#agenticyaml))

## Install

```bash
# globally
npm install -g agentic-dev-runner@0.1.0

# or run without installing (the package exposes the "agentic" binary)
npx agentic-dev-runner@0.1.0 --help
```

Either way the command is `agentic`:

```bash
agentic version
```

## Quickstart

The walkthrough below is fixture-free: any Git repository with a non-empty
`AGENTS.md` and one working verification command will do.

### 1. Configure the project (`agentic.yaml`)

Create `agentic.yaml` at the repository root. One verification check and one
agent profile are enough to start:

```yaml
verification:
  checks:
    unit:
      command: pnpm
      args:
        - test
agents:
  profiles:
    opencode:
      adapter: opencode
      model: opencode/gpt-5
      capabilities:
        - typescript
```

`verification.checks` are named commands the runner executes itself;
`agents.profiles` map profile ids to provider adapters. Swap `adapter: opencode`
for `adapter: codex` to use the Codex CLI instead.

### 2. Initialize local runner state

```bash
agentic init
```

Local state lives outside the repository, per machine, keyed to the
normalized repository path: `~/.agentic/projects/<project-key>/state.db` plus
`~/.agentic/projects/<project-key>/worktrees/`. Moving or renaming the
repository directory creates a new local state identity; no state migration is
performed.

### 3. Author a task

Save this as `task.json` — the documented task schema
([`docs/TASK_SCHEMA.md`](https://github.com/SohailElskhawy/agent-runner/blob/master/docs/TASK_SCHEMA.md))
in JSON form:

```json
{
  "id": "M001",
  "title": "Add a formatDuration helper",
  "milestone": "utilities",
  "status": "ready",
  "priority": "P1",
  "risk": "low",
  "type": "implementation",
  "objective": "Add a formatDuration(ms) helper that returns a compact human-readable duration string and is covered by a unit test.",
  "acceptance_criteria": [
    "formatDuration(0) returns \"0s\"",
    "formatDuration(65000) returns \"1m 5s\"",
    "A unit test covers both cases and passes"
  ],
  "depends_on": [],
  "provenance": {
    "kind": "user_request",
    "source": "README quickstart example"
  },
  "scope": {
    "allowed_paths": [
      "src/utils/**",
      "test/utils/**"
    ],
    "forbidden_paths": [
      "src/api/**"
    ]
  },
  "resources": [
    "utils"
  ],
  "workflow": "simple",
  "routing": {
    "complexity": "trivial",
    "capabilities": [
      "typescript"
    ]
  },
  "verification": {
    "required": [
      "unit"
    ]
  },
  "limits": {
    "max_attempts": 3,
    "max_review_cycles": 1
  },
  "approval": {
    "required": false
  }
}
```

### 4. Add and run

```bash
agentic tasks add task.json
agentic run --parallel 3
agentic status
agentic inspect M001
```

`tasks add` validates the file against the task contract and persists it;
validation errors are reported before anything executes. `run --parallel 3`
lets the unattended scheduler execute up to three independent tasks
concurrently (tasks whose dependencies are not `DONE` wait). To execute one
task sequentially instead, use `agentic run M001`.

## Command reference

| Command | Description |
| --- | --- |
| `agentic init` | Initialize local runner state (SQLite database and worktrees root) for the current repository. Requires a valid `agentic.yaml`. |
| `agentic run <task-id>` | Execute one task's resolved workflow (default: PLAN → PLAN_REVIEW → IMPLEMENT → CODE_REVIEW → VERIFY → INTEGRATE) with integration verification before `DONE`. |
| `agentic run [--parallel <n>]` | Unattended DAG execution of every runnable task; `--parallel <n>` caps concurrent tasks (positive integer, default 1). |
| `agentic run-all [--parallel <n>]` | Compatibility alias for unattended `agentic run`. |
| `agentic status` | Project status: tasks and states, active/failed/blocked tasks, recovery-required work, execution claims, integration queue, and parallel capacity. |
| `agentic inspect <task-id>` | Explain one task: attempts, agent/profile, workflow stage results, verification evidence, task commit, integration outcome, and recovery events. |
| `agentic approve <task-id>` | Record durable human approval for a task that declares `approval.required: true`. The grant survives failure and retry. |
| `agentic retry <task-id>` | Return a `FAILED`, `NEEDS_HUMAN`, or `BLOCKED` task to `READY`. Respects `limits.max_attempts`; approval-required tasks must be approved first. |
| `agentic tasks [add <task-file>]` | With no subcommand, list persisted tasks (status, priority, milestone, dependencies, attempts, approval). `tasks add` ingests one JSON task file. |
| `agentic doctor` | Local preflight checks (Node, Git, project state, configuration, coding agents, worktrees directory), PASS/WARN/FAIL per check; exits non-zero on any FAIL. |
| `agentic agents` | Report which built-in coding-agent CLIs are locally available and their versions. |
| `agentic help` | Print the usage text. |
| `agentic version` | Print the CLI version. |

`agentic --help`/`-h` are aliases for `agentic help`; `agentic --version`/`-v`
are aliases for `agentic version`. An explicit `agentic run <task-id>` is a
direct human instruction and is not blocked by `approval.required`; the
approval gate applies to unattended scheduling. Commands exit `0` on success
and non-zero on failure.

## How it works

**Worktree-per-task.** For each attempt the runner creates a dedicated Git
worktree outside the repository (`…/worktrees/<task-id>/attempt-<n>/`) on a
task branch. The agent only ever sees its own worktree, so concurrent tasks
cannot overwrite each other's files. The runner controls all Git operations;
agents never merge, rebase, or touch other tasks' branches.

**Workflow stages.** Each task declares a workflow id, resolved to a fixed
stage sequence:

| Workflow | Stages |
| --- | --- |
| `simple` | IMPLEMENT → VERIFY → INTEGRATE |
| `default` | PLAN → PLAN_REVIEW → IMPLEMENT → CODE_REVIEW → VERIFY → INTEGRATE |
| `security-critical` | Same stage sequence as `default` in v0.1 |

Review and retry loops are bounded by the task's `limits`.

**Verification is runner-owned.** The runner — not the agent — executes the
checks named in the task's `verification.required` using the commands defined
in `agentic.yaml`. Checks run inside the task worktree first. When the task
commit is ready, the runner synchronizes it with the latest integration state,
runs the checks again against the integrated result, and only then marks the
task `DONE`. A task that requires a check with no configured command is
rejected before execution begins.

**Scheduler, claims, and locks.** Unattended execution admits a task only when
it is `READY`, its `depends_on` tasks are `DONE`, its approval requirements are
satisfied, no conflicting exclusive resource lock is held, parallelism
capacity is available, and an eligible agent profile exists. Admission is
recorded as an execution claim so a crash or a second process cannot start the
same task twice. Tasks that declare the same logical `resources` are excluded
from running concurrently even when their file scopes are disjoint.

**Crash recovery.** Every stage follows *persist intent → perform action →
inspect actual outcome → persist result*. On startup the runner reconciles
persisted state with real branches, worktrees, commits, claims, and unfinished
attempts, and classifies the interrupted work as safe to retry, requiring
reconciliation, or requiring a human. Runtime state and attempt history
survive process termination.

**Context packs.** Each agent invocation receives a fresh ContextPack built
from the task contract (objective, acceptance criteria, scope, dependencies),
the repository's `AGENTS.md` rules, plan/review artifacts, and the base
revision — not a repository dump. The manifest of exactly what was sent
(content digests) is persisted with the attempt.

## `agentic.yaml`

Project configuration is resolved from `agentic.yaml` in the repository root.
Unknown fields are rejected so configuration mistakes fail loudly.

```yaml
verification:
  checks:
    unit:            # check name; tasks reference it in verification.required
      command: pnpm  # executable; invoked directly, never through a shell
      args:          # argument array
        - test
agents:
  profiles:
    opencode:
      adapter: opencode      # built-in adapter: opencode | codex
      model: opencode/gpt-5  # optional, opaque model id passed to the adapter
      capabilities:          # task capabilities this profile can satisfy
        - typescript
```

- `verification.checks` is required and must define at least one check. Each
  check has a `command` (string) and `args` (array of strings). The command is
  spawned directly with an argument array and the worktree as the working
  directory.
- `agents` is optional, but unattended execution needs at least one profile
  that is both available locally and eligible for the task. `capabilities` are
  matched exactly against the task's `routing.capabilities` (case-insensitive,
  after trimming); a missing capability makes the profile ineligible.
- A task requiring a check name that is not configured is rejected before
  execution.

## Task authoring

Tasks are manually authored files. The authoritative format is
[`docs/TASK_SCHEMA.md`](https://github.com/SohailElskhawy/agent-runner/blob/master/docs/TASK_SCHEMA.md),
documented in YAML for readability; `agentic tasks add` parses the same schema
as JSON.

Every top-level key is required. Use `snake_case` for the documented
multi-word fields and lowercase status values:

- `id` (stable, unique, not reused), `title`, `milestone`
- `status`: `backlog` or `ready`
- `priority`: `P<number>` (for example `P0`, `P1`)
- `risk`: `low` | `medium` | `high` | `critical`
- `type`: `implementation` | `bugfix` | `refactor` | `test` | `documentation` | `spike`
- `objective` (one capability) and `acceptance_criteria` (at least one)
- `depends_on` (task ids that must reach `DONE` first; acyclic)
- `provenance`: `{ kind, source }` (why the task exists)
- `scope`: `{ allowed_paths, forbidden_paths }` (relative patterns using `/`)
- `resources` (logical areas that must not run concurrently)
- `workflow`: `simple` | `default` | `security-critical`
- `routing`: `{ complexity, capabilities }`
- `verification`: `{ required: [check names] }` (omitted checks are not run)
- `limits`: `{ max_attempts, max_review_cycles }`
- `approval`: `{ required, reason? }`

## Security model

Coding agents are treated as untrusted workers. Safety does not depend on
prompting; the runner enforces it:

- **Scope validation against the Git delta.** After implementation, the
  changed paths are compared against the task's `allowed_paths` and
  `forbidden_paths`. Unexpected changes are scope violations and fail the
  workflow stage; the runner never widens scope on the agent's behalf.
- **Isolation.** Each attempt runs in its own Git worktree and branch outside
  the repository. The runner owns branch creation, task commits, and
  integration.
- **Verification gate.** Completion requires runner-executed verification
  in the worktree and again on the integrated result.
- **Bounded execution.** Agent timeouts, cancellation, retry budgets, and
  review-cycle limits are configured by the runner, not the agent.
- **Local-first state.** Runtime state, events, and worktrees stay on the
  machine under `~/.agentic/projects/`; v0.1 has no cloud control plane and no
  remote execution.
- **Credentials.** The runner does not write environment variables or
  credentials into task state or events. Agent stdout/stderr is persisted as
  stage output for diagnosis, so keep secrets out of task files and agent
  configuration.

Known v0.1 limitation: timeout/cancel terminates the direct agent process
only, not its process tree.

## Contributing

Development setup, verification commands, live-test gates, cross-platform
rules, and the PR checklist are in
[`CONTRIBUTING.md`](https://github.com/SohailElskhawy/agent-runner/blob/master/CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 Sohail Elskhawy.

The publishable bundle embeds third-party packages; see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
