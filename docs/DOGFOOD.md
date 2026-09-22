# Multi-Task Dogfood Scenario

This scenario proves the real product path end to end: three tasks forming the
dependency DAG `A,B -> C` run through the actual `agentic` CLI, with real
worktrees, real verification, real serialized integration, and inspectable
task commits.

## Prerequisites

- Node.js >= 24
- A coding-agent CLI installed locally and on `PATH` (for example `opencode`
  or `codex`). Check availability with `agentic agents`.
- The repository's `agentic.yaml` must reference that agent through an agent
  profile (the fixture created below does).

> Windows note: agents installed as `.cmd` shims (for example the npm
> `opencode` launcher) may not be spawnable by the runner's direct child
> process invocation. Prefer an agent whose executable is a native binary
> (for example `codex`) by changing the fixture profile's `adapter:` field to
> `codex` and committing the change before running.

## Create the fixture

```bash
node scripts/dogfood/multi-task-fixture.mjs
```

The script creates a scratch fixture repository with:

- `agentic.yaml` defining one real verification check (`unit`) and one agent
  profile (`opencode`)
- three task files:

```text
A ─┐
   ├─→ C
B ─┘
```

A and B are independent and conflict-free (disjoint scopes and resources), so
the unattended scheduler may run them concurrently. C depends on both and only
becomes runnable after both reach DONE.

## Run the scenario

Use the printed commands from the script output, or:

```bash
cd "<fixture repo>"
agentic init
agentic tasks add "<tasks dir>/task-A.json"
agentic tasks add "<tasks dir>/task-B.json"
agentic tasks add "<tasks dir>/task-C.json"
agentic run --parallel 2
agentic status
agentic inspect A
agentic inspect B
agentic inspect C
git log --oneline
```

## What you should observe

- `agentic run --parallel 2` executes A and B concurrently, each in its own
  isolated worktree, then integrates their commits serially; C starts
  automatically after both reach DONE.
- Verification (`node --test`) runs in every task worktree and again against
  the integrated result before a task is marked DONE.
- `git log` contains one atomic commit per task (`task A: ...`,
  `task B: ...`, `task C: ...`) on the integration branch.
- `agentic status` reports `3 DONE`, no active tasks, no active claims, and an
  empty integration queue.
- `agentic inspect <task-id>` explains each task: attempts, agent/profile,
  workflow stage results, verification evidence, the task commit, the
  integration queue outcome, and any recovery events.

This scenario was verified manually with a real `codex` agent: A and B held
execution claims simultaneously (claimed 18 ms apart, each running for ~45 s
in its own worktree), C was admitted only after both finished, and the final
history contained the three atomic task commits with all six fixture tests
passing in the integrated result.

## CI equivalent

The automated CI version of this scenario lives in
`packages/cli/test/multi-task-dag-e2e.test.ts`. It uses the same production
CLI/application path with the real OpenCode adapter pointed at a deterministic
fixture agent executable, so no external coding-agent installation is needed.
