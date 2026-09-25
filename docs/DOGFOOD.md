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

> Windows note: Windows `.cmd` and `.bat` shims (such as npm's global `opencode`
> launcher) are natively resolved and supported by the runner's platform adapter.

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

---

# 20-Task Roadmap Dogfood (V0.1 Release Criterion 1)

This scenario proves V0.1 release criterion 1 end-to-end against a real coding
agent: 20 tasks forming a 4-layer dependency DAG execute unattended through the
`agentic` CLI with parallel workers (`--parallel 4`), concurrency control via
shared resource locking, worktree isolation, dual verification, serialized
integration, and inspectable task commits.

## Prerequisites

- Node.js >= 24
- A coding-agent CLI installed locally and authenticated on `PATH` (for
  example `opencode` or `codex`). Windows `.cmd` and `.bat` shims (such as
  npm's `opencode` launcher) are natively resolved and supported via the platform
  adapter. Verify installed agents with `agentic agents`.
- The repository's `agentic.yaml` references that agent through an agent profile
  (the generated fixture defaults to `opencode`; adjust the `adapter:` field if
  using another agent such as `codex`).
- Sufficient provider API quota/credits for a 20-task automated run.

## Create the fixture

```bash
node scripts/dogfood/roadmap-20-fixture.mjs [target-directory]
```

The script creates a scratch fixture repository containing:

- `AGENTS.md` specifying repository dogfood rules.
- `README.md` fixture documentation.
- `agentic.yaml` with a `unit` verification check (`node --test test/**/*.test.cjs`)
  and an `opencode` agent profile.
- 20 task definition JSON files (`task-T01.json` through `task-T20.json`) structured
  across 4 dependency layers:

```text
Layer 1 (roots):     T01   T02   T03   T04   T05   T06
                      │     │     │     │     │     │
Layer 2:             T07(T01,T02) T08(T03) T09(T04,T05) T10(T06) T11(T02,T06) T12(T01,T05)
                      │            │        │        │        │             │
Layer 3:             T13(T07,T08) ────────┘        T14(T09,T10)  T15(T11)      T16(T12)  T17(T07,T11)
                      │                             │             │             │         │
Layer 4:             T18(T13,T14) ─────────────────┘             T19(T15,T16) ─┘         T20(T17)
```

- **Dependency DAG**:
  - `T07` depends on `T01`, `T02`
  - `T08` depends on `T03`
  - `T09` depends on `T04`, `T05`
  - `T10` depends on `T06`
  - `T11` depends on `T02`, `T06`
  - `T12` depends on `T01`, `T05`
  - `T13` depends on `T07`, `T08`
  - `T14` depends on `T09`, `T10`
  - `T15` depends on `T11`
  - `T16` depends on `T12`
  - `T17` depends on `T07`, `T11`
  - `T18` depends on `T13`, `T14`
  - `T19` depends on `T15`, `T16`
  - `T20` depends on `T17`
- **Resource locking**:
  - `T01`, `T02`, `T07`, and `T11` share the `"resource-roadmap-shared"` lock. Even
    when multiple workers are idle, these tasks never execute concurrently.
  - All other tasks acquire isolated resource locks (`resource-t03`, `resource-t04`,
    etc.).

## Run the scenario

```bash
cd "<fixture repo>"
agentic init
agentic tasks add "<tasks dir>/task-T01.json"
agentic tasks add "<tasks dir>/task-T02.json"
agentic tasks add "<tasks dir>/task-T03.json"
agentic tasks add "<tasks dir>/task-T04.json"
agentic tasks add "<tasks dir>/task-T05.json"
agentic tasks add "<tasks dir>/task-T06.json"
agentic tasks add "<tasks dir>/task-T07.json"
agentic tasks add "<tasks dir>/task-T08.json"
agentic tasks add "<tasks dir>/task-T09.json"
agentic tasks add "<tasks dir>/task-T10.json"
agentic tasks add "<tasks dir>/task-T11.json"
agentic tasks add "<tasks dir>/task-T12.json"
agentic tasks add "<tasks dir>/task-T13.json"
agentic tasks add "<tasks dir>/task-T14.json"
agentic tasks add "<tasks dir>/task-T15.json"
agentic tasks add "<tasks dir>/task-T16.json"
agentic tasks add "<tasks dir>/task-T17.json"
agentic tasks add "<tasks dir>/task-T18.json"
agentic tasks add "<tasks dir>/task-T19.json"
agentic tasks add "<tasks dir>/task-T20.json"
agentic run --parallel 4
agentic status
agentic inspect T20
git log --oneline
```

## Expected evidence

Upon successful completion of the run:

1. **Task completion**: All 20 tasks reach status `DONE`.
2. **Git history**: Exactly 21 commits on the integration branch (1 initial commit +
   20 atomic task commits formatted as `task <ID>: ...`).
3. **Serialized integration queue**: Exactly 20 completed queue entries, 0 pending,
   0 integrating, and 0 failed.
4. **DAG ordering**: Every dependent task attempt started at or after the timestamp
   when all of its prerequisites reached finishedAt / DONE.
5. **Mutual exclusion**: Execution spans for shared-resource tasks (`T01`, `T02`,
   `T07`, `T11`) are strictly disjoint.
6. **Worktree isolation**: 20 distinct worktrees were created and cleaned up.
7. **Verification**: Dual verification succeeded for every task (first inside the
   task worktree, and again on the integration branch before landing).
8. **Final CLI status**: `agentic status` outputs:
   - `task totals: 20 DONE`
   - `active tasks: (none)`
   - `integration queue: 0 pending, 0 integrating, 20 completed, 0 failed`

> **Note on transcripts**: Actual dogfood transcripts require external agent
> authentication and execution time with a live provider (e.g. OpenAI, Anthropic).
> Real captured transcripts are appended here after running with live agent credentials.
>
> For continuous automated verification without external agent credentials, the CI
> test suite runs this exact 20-task DAG and asserts all 8 criteria via
> `packages/cli/test/roadmap-20-tasks-e2e.test.ts`.
