# Additional Agent Adapters + v0.1 Release — Design Spec

**Date:** 2026-09-28
**Status:** Proposed — awaiting user review before implementation planning

## Context

The execution engine is implemented, tested, and pushed to `origin/master`, but v0.1.0 is not yet tagged or published to npm. Two agent adapters exist: Codex and OpenCode.

`docs/LAUNCH_SPRINT_ROADMAP.md` proposed pulling the planning loop (`analyze`, readiness, discovery, `plan`, task generation) into v0.1. Its target date has passed.

## Decisions

1. **Launch bar:** ship v0.1 as the execution engine plus additional agent adapters. The planning loop (L002–L011) stays in v0.2, as the committed 2026-09-24 spec already decided.
2. **New adapters in v0.1:** Claude Code, Gemini CLI, Antigravity (`agy`), and GitHub Copilot CLI. With Codex and OpenCode, v0.1 supports six agents.
3. **Deferred adapters:** Cursor CLI (no live test access), Aider, Qwen Code, Goose, Amp, and Kiro, depending on demand.
4. **Adapter structure:** extract a shared CLI adapter. Each provider becomes a small definition.
5. **Code quality bar:** this is an open-source developer tool. Code must be readable by outside contributors, and adding an adapter must be an obvious, documented, small change.

## Non-goals

- No change to core, the orchestrator, persistence, the task schema, or the `AgentRuntime` contract.
- No config-defined (YAML) custom adapters.
- No routing, cost, or escalation changes.
- No planning-loop work.

---

## A1 — Shared CLI adapter

Codex and OpenCode are near-identical (~190 lines each). The only differences are their arguments and prompt. Extract the shared behavior:

`packages/agents/src/adapters/cli-agent-adapter.ts`

- `CliAgentDefinition` holds the provider-specific part:
  - `id`: the agent id, e.g. `"claude"`
  - `defaultExecutable`: e.g. `"claude"`
  - `probeArgs`: usually `["--version"]`
  - `buildArgs({ model, prompt }): string[]`: the headless invocation arguments
- `CliAgentAdapter implements AgentRuntime` owns the shared behavior:
  - input validation (non-empty worktree path, positive timeout)
  - writing the context pack to a private temp file (`0o600`) and always cleaning it up
  - the shared prompt ("Read the task context pack at … and complete the task." plus the stage instruction)
  - spawning through `ProcessRunner` (argument arrays, no shell strings) in the worktree
  - normalizing `ProcessResult` into `AgentExecutionResult` (success, failure, timeout, cancelled, spawn-error)
  - `probeAvailability()` via `normalizeProbeResult`
- The existing options (`executable`, `model`, `launcherArgs`, `removeDirectory`) are kept unchanged.

Codex and OpenCode are migrated onto it. Their public exports (`CodexAdapter`, `OpenCodeAdapter`, the `*_AGENT_ID` constants) keep working, so the CLI wiring and consumers don't change. Their existing tests must pass unmodified. That is the proof that behavior didn't change.

## A2 — New adapters

Each adapter is one file under `packages/agents/src/adapters/<provider>/` that exports a definition, an id constant, and an adapter class or factory in the same style as Codex.

| Agent id | Executable | Headless invocation (model appended as `--model <m>` when set) |
|---|---|---|
| `claude` | `claude` | `-p <prompt> --permission-mode acceptEdits` |
| `gemini` | `gemini` | `-p <prompt> --approval-mode auto_edit` |
| `antigravity` | `agy` | `-p <prompt> --mode accept-edits` (confirmed from `agy --help`, v1.2.12) |
| `copilot` | `copilot` | `-p <prompt> --allow-all-tools` |

**Flag rule:** before implementing each adapter, confirm its flags against the installed CLI's `--help`. The table is the starting assumption, not the source of truth. Pick the narrowest mode that lets the agent edit files and run commands without prompting, with the worktree as the working directory. Prefer "accept edits" modes over blanket "skip all permissions" modes when they allow a non-interactive run. If a CLI needs the broader mode to finish headless tasks (for example, to run verification commands), use it, and document it in the adapter file and the README security section.

**Registration:** add all four in `packages/cli/src/application/app-services.ts` next to the existing adapters. `agentic agents` and `agentic doctor` then detect them automatically. Export them from `packages/agents/src/index.ts`.

## A3 — Testing

- **Shared adapter unit tests:** a fake `ProcessRunner` covers argument building, temp-file creation and cleanup (including on failure), and each result kind.
- **Per-adapter unit tests:** a small table-driven test per provider asserts the exact executable and arguments, with and without a model, and the probe arguments.
- **Codex and OpenCode tests:** unchanged, and they must pass (regression guard for the refactor).
- **Live checks (env-gated, local only, not in CI):** reuse the existing real-agent test gating pattern. For each new CLI, a smoke test runs one trivial task in a temp Git repo and asserts success and a file change. The user runs these locally for Claude, Gemini, Antigravity, and Copilot. Results are recorded in `docs/RELEASE.md`.
- Full `pnpm build`, `typecheck`, `lint`, and `test` must pass, and CI stays green on all three OSes.

## A4 — Documentation

- **README:** supported-agents table (id, install command, login step, known permission mode), plus how to select an agent in `agentic.yaml`.
- **CONTRIBUTING:** an "Adding an agent adapter" section covering the definition file, registration, tests, and the live smoke check.
- **CHANGELOG:** add the new adapters and set the real release date.
- **`docs/LAUNCH_SPRINT_ROADMAP.md`:** commit it with a status note saying planning-loop tasks L002–L013 are the v0.2 plan. `LONG_TERM_PRODUCT_VISION.md` is committed as-is.

## A5 — Release

Follow the existing `docs/RELEASE.md` checklist:

- CI green
- pack smoke test
- live adapter checks recorded
- version `0.1.0`
- tag `v0.1.0`
- GitHub release
- manual `npm publish`
- post-publish `npx agentic-dev-runner@0.1.0` smoke test

Each outward step (push, tag, publish) is confirmed with the user before it runs.

## Acceptance

- `agentic agents` lists six agents and reports availability for each.
- The refactor leaves Codex and OpenCode behavior and tests unchanged.
- Each new adapter has unit tests and a recorded live smoke result.
- No provider-specific conditionals exist outside the adapter files and the registration list.
- v0.1.0 is tagged, released on GitHub, and installable from npm.
