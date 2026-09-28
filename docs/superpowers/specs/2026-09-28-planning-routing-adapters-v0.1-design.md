# v0.1: Planning, Cheap-First Routing, Adapters, Release — Design Spec

**Date:** 2026-09-28
**Status:** Design approved in conversation; this written spec awaits user review before implementation planning.
**Supersedes:** the planning-loop deferral in `2026-09-24-v0.1-open-source-launch-design.md` (Decision 1).

## Product goal

A developer can break a project into very small, well-defined tasks and delegate them to cheap models. A strong model plans, the developer approves, and cheap models execute under runner-controlled verification, with bounded escalation.

The execution engine (worktrees, verification, integration, retries, recovery, scheduler) is done and is reused unchanged except where stated.

## Decisions

1. **Who decomposes:** an AI planner (a strong-tier profile) proposes the plan, and the developer reviews, edits, and approves it.
2. **Discovery scope:** lightweight. The planner either returns a plan or returns open questions. Answers go in a decisions file, then the developer re-runs `plan`. No interactive discovery sessions. Empty repos work when the key decisions are written down.
3. **Cost model:** explicit profile tiers (`economy | standard | strong`) set by the user. The core holds no prices and no provider knowledge.
4. **Adapters:** Claude Code, Gemini CLI, Antigravity (`agy`), and Copilot CLI, built on a shared CLI adapter. Cursor, Aider, Qwen, Goose, Amp, and Kiro are deferred.
5. **Quality bar:** this is an open-source tool for developers. Code must be readable, with small focused modules, no duplication, and obvious extension points for contributors.

## Work order

1. **P1:** cheap-first routing and escalation
2. **P2:** planner
3. **P3:** real-agent dogfood
4. **P4:** shared adapter and new adapters
5. **P5:** docs and release

## Non-goals (v0.1)

- Interactive discovery sessions and readiness scoring.
- Learned or adaptive routing, and cost analytics in dollars.
- Mid-execution task splitting.
- Config-defined custom adapters.
- GUI, remote workers, issue-tracker integrations.

---

## P1 — Cheap-first routing and escalation

### Configuration

`agents.profiles.<id>.tier` accepts `economy | standard | strong`. It is optional and defaults to `standard`, so existing configs keep working.

```yaml
agents:
  profiles:
    cheap:  { adapter: opencode, model: <cheap-model>,  tier: economy }
    mid:    { adapter: codex,    model: <mid-model>,    tier: standard }
    strong: { adapter: claude,   model: <strong-model>, tier: strong }
```

### Domain (packages/core)

- `AgentProfile` gains `tier: AgentTier`.
- New pure module `routing-policy.ts`:
  - `minimumTierFor(complexity, risk): AgentTier`
    - `high` or `critical` risk, or `large` complexity: `strong`
    - `medium` complexity or `medium` risk: `standard`
    - otherwise: `economy`
    - The exact complexity values come from `TASK_COMPLEXITIES`.
  - `escalatedTier(minimum, failedAttempts): AgentTier` raises the minimum one tier per prior failed attempt, capped at `strong`.
- `selectAgentProfile` receives the required minimum tier. It filters out candidates below that tier (a new rejection reason, `below-minimum-tier`). Among the remaining available, capable candidates it picks the lowest tier. Configured order is the tie-breaker. Capability and availability rules are unchanged and take precedence. The result stays deterministic.
- If no candidate meets the minimum tier, the result is no-route with diagnostics. It never silently downgrades.

### Escalation

- The existing retry/attempt budget (`maxAttempts`) stays authoritative. Escalation only changes which profile the next attempt uses, so it cannot add attempts.
- The escalation input is the count of failed prior attempts for the task, read from persisted attempts.

### Observability

- Persist a `task.routing.decided` event per attempt containing:
  - profile id and tier
  - minimum tier
  - reason (`complexity=small, risk=low` / `escalated after 1 failed attempt`)
- `agentic inspect` renders it.

### Tests

- Unit tests for `minimumTierFor`, `escalatedTier`, and router tier selection and rejections.
- An application test proves that a failed economy attempt retries on the next tier up.

---

## P2 — Planner

### Commands

(The CLI parses input, calls an application service, and renders the result.)

- `agentic plan --goal "<text>"` creates a draft plan or writes open questions.
- `agentic plan show [<plan-id>]` summarizes a draft (latest by default):
  - milestones
  - task count by tier
  - immediately runnable count
  - approval-gated count
  - max parallelism
  - a task list, grouped by milestone
- `agentic plan approve <plan-id>` imports the draft's tasks.

### Configuration

```yaml
planning:
  profile: strong           # agent profile used for planning (required for `plan`)
  max_repair_attempts: 2    # default 2
```

### Planning input (packages/core domain type `PlanningInput`)

Provider-independent, bounded, and deterministic in order and size:

- goal text
- base commit (HEAD SHA)
- `AGENTS.md`, and `docs/**/*.md` up to a size budget
- package manifests found at the root and one level down
- tracked file tree (paths only, capped)
- decisions file `.agentic/decisions.md` (if present)
- existing task ids (to avoid collisions)

Missing files are recorded as absent, not treated as errors.

### Planner invocation (packages/cli application layer, reusing the agents runtime)

1. Create a temporary detached worktree at HEAD through the existing Git manager.
2. Invoke the planning profile's adapter with a planning instruction. The planner writes `agentic-plan.json` at the worktree root and must not modify other files.
3. Read and parse the output, then remove the worktree. The runner never integrates anything from it.

### Planner output contract (versioned JSON, validated by the runner)

```jsonc
// either
{ "version": 1, "kind": "questions",
  "questions": [{ "id": "Q1", "question": "...", "why": "..." }] }
// or
{ "version": 1, "kind": "plan",
  "milestones": [{ "id": "M1", "title": "...", "completion_criteria": ["..."] }],
  "tasks": [ /* draft tasks, see below */ ] }
```

**Draft task fields:**

- Required from the planner: `id`, `title`, `milestone`, `objective`, `acceptance_criteria`, `depends_on`, `scope.allowed_paths`, `resources`, `risk`, `type`, `routing.complexity`, `routing.capabilities`, `verification.required`.
- Filled in by the runner with defaults:
  - `status: ready`
  - `priority` from milestone order
  - `workflow` from risk (`low` → `simple`, `medium` → `default`, `high`/`critical` → `security-critical`)
  - `provenance: { kind: <goal kind>, source: "plan <plan-id>" }`
  - `scope.forbidden_paths: []`
  - approval required for `high` and `critical` risk

### Validation

Every check is deterministic, and all errors are collected rather than stopping at the first:

- JSON shape and version.
- Each completed task passes the existing `validateManualTaskInput`.
- Task ids are unique and don't collide with existing tasks. Dependencies resolve and are acyclic.
- `verification.required` names only configured checks.
- **Size limits (task smallness):**
  - complexity must not be above `medium`
  - at most 5 acceptance criteria
  - at most 8 `allowed_paths` entries
  - Tasks that break these are returned for splitting.
- Every task references an existing milestone, and every milestone has at least one task.

### Repair loop

On validation failure, re-invoke the planner with the error list (up to `max_repair_attempts`). If it still fails, the command exits non-zero, prints the errors, and keeps the last raw output for inspection. Nothing is imported.

### Questions path

The planner's questions are appended to `.agentic/decisions.md` as a `## Open questions` section with empty `Answer:` lines. `plan` exits with a message telling the user to answer them and re-run. On the next run the decisions file is part of the input.

### Draft storage

`.agentic/plans/<plan-id>/` contains:

- `plan.json`: the completed, validated tasks
- `summary.md`: human-readable
- `input.json`: the planning input digest, for reproducibility

Drafts are plain files the user may edit. `plan-id` is time-based and sortable.

### Approval

`plan approve <plan-id>`:

1. Re-validates the (possibly edited) draft.
2. Imports all tasks into the SQLite store in **one transaction**, with a `plan.approved` event (plan id, task ids, base commit).
3. Marks the draft approved (a marker file), so it can't be approved twice.
4. Rejects the approval if the store changed in a way that invalidates the draft (id collision).

Unapproved drafts are never executable.

### Authority invariants

- The planner cannot change runner state. Only `plan approve` imports tasks.
- The approved plan is fixed. Later work needs a new `plan` and a new approval.

### Tests

- Unit tests for the input builder (bounded, with missing files), output parser, defaults filler, validator (each rule), and questions-file writer.
- Application tests for the full `plan → show → approve` flow with a fake planner adapter, covering the questions path, the repair loop succeeding and failing, and approve being idempotent or rejecting a second approval.

---

## P3 — Real-agent dogfood

This runs locally and is not part of CI. Evidence goes in `docs/DOGFOOD.md`.

1. **Defined project:** a small repo with a written spec.
   - `plan` → approve → produces 10 or more tasks
   - `run --parallel 4` using an economy profile
   - all tasks DONE, or blocked failures that are bounded and explained
   - routing and escalation events are visible
2. **Empty repo:** a goal with no decisions.
   - `plan` produces questions
   - the questions are answered
   - `plan` then produces a plan, which is approved, run, and verified

Planner prompt or validator changes that come out of the dogfood are in scope. Changes to engine behavior are not, unless they fix a bug.

---

## P4 — Shared CLI adapter and new adapters

### Shared adapter

`packages/agents/src/adapters/cli-agent-adapter.ts` has two parts:

- **`CliAgentDefinition`**, the provider-specific part:
  - `id`
  - `defaultExecutable`
  - `probeArgs`
  - `buildArgs({ model, prompt }): string[]`
- **`CliAgentAdapter implements AgentRuntime`**, the shared behavior:
  - input validation
  - private temp context-pack file (`0o600`), always cleaned up
  - shared prompt plus stage instruction
  - `ProcessRunner` spawn with argument arrays in the worktree
  - result normalization
  - availability probe

Codex and OpenCode migrate onto it. Their public exports and existing tests stay unchanged, which acts as a regression guard.

### New adapters

Each is one file in `packages/agents/src/adapters/<provider>/`.

| Agent id | Executable | Starting invocation (`--model <m>` appended when set) |
|---|---|---|
| `claude` | `claude` | `-p <prompt> --permission-mode acceptEdits` |
| `gemini` | `gemini` | `-p <prompt> --approval-mode auto_edit` |
| `antigravity` | `agy` | `-p <prompt> --mode accept-edits` (confirmed from `agy --help`, v1.2.12) |
| `copilot` | `copilot` | `-p <prompt> --allow-all-tools` |

- **Flag rule:** confirm flags against each installed CLI's `--help` before implementing. Use the narrowest non-interactive mode that lets the agent edit files and run commands. When a broader "skip permissions" mode is required, document it in the adapter file and the README security section.
- **Registration:** register the adapters in `packages/cli/src/application/app-services.ts` and export them from `packages/agents/src/index.ts`.
- **Tests:**
  - shared adapter unit tests
  - a table-driven args and probe test per provider
  - env-gated live smoke tests, run locally for Claude, Gemini, Antigravity, and Copilot, with results recorded in `docs/RELEASE.md`

---

## P5 — Documentation and release

### Documentation

- **README:** rewrite the quickstart around `init → plan → plan show → plan approve → run → status`. Add sections on:
  - tiers and escalation
  - the decisions file
  - the supported-agents table (install, login, permission mode)
  - hand-written tasks as the advanced path
- **CONTRIBUTING:** add "Adding an agent adapter" and "How routing tiers work".
- **Spec documents:** update `PROJECT_SPEC`, `ROADMAP`, `V0.1_SCOPE`, `ARCHITECTURE`, and `TASK_SCHEMA` so planning and tiers are in v0.1 and interactive discovery is in v0.2.
- **Untracked docs:** commit `LAUNCH_SPRINT_ROADMAP.md` with a status note mapping it to this spec, and commit `LONG_TERM_PRODUCT_VISION.md` as-is.
- **CHANGELOG:** 0.1.0 entry with the real release date.

### Release

Follow `docs/RELEASE.md`:

- CI green on 3 OSes
- pack smoke test
- live adapter checks and dogfood evidence recorded
- tag `v0.1.0`
- GitHub release
- manual `npm publish`
- post-publish `npx` smoke test

Each outward step (push, tag, publish) is confirmed with the user first.

---

## Acceptance (v0.1)

- `agentic plan` turns a goal and repo into a validated draft of small tasks, or into open questions, and nothing runs before `plan approve`.
- Approved tasks run through the existing engine with no manual JSON editing.
- The router picks the cheapest capable tier allowed by complexity and risk, escalates within the attempt budget, and every decision is visible in `inspect`.
- Six agents are supported, and the Codex and OpenCode behavior is unchanged.
- Both dogfood flows are completed with real agents and documented.
- `pnpm build`, `typecheck`, `lint`, and `test` are green, and CI is green on Windows, macOS, and Linux.
- v0.1.0 is tagged, released, and installable from npm.
