### ADR-001 — TypeScript + Node.js

**Status:** Accepted

**Decision:** Build the core platform in TypeScript running on Node.js.

**Why:** Strong typing, mature CLI/process tooling, excellent ecosystem, cross-platform support, and easy future GUI integration.

---

### ADR-002 — Headless Core

**Status:** Accepted

**Decision:** CLI, future GUI, and future APIs must all call the same application/core layer.

```text
CLI ─┐
GUI ─┼→ Application Layer → Core
API ─┘
```

No orchestration logic belongs inside the CLI.

---

### ADR-003 — Local-First Architecture

**Status:** Accepted

**Decision:** V0.1 runs entirely on the developer's machine.

Source code, credentials, state, worktrees, and logs remain local unless a configured provider requires remote model access.

---

### ADR-004 — SQLite Runtime State

**Status:** Accepted

**Decision:** SQLite is the canonical orchestration database.

Git remains canonical for source history. Markdown/YAML remain canonical for human-authored project contracts.

SQLite driver details stay behind an abstraction.

---

### ADR-005 — Durable Explicit State Machine

**Status:** Accepted

**Decision:** Task progress is represented through persisted state transitions controlled only by the orchestrator.

Agents cannot directly mark tasks completed.

---

### ADR-006 — Task and Attempt Separation

**Status:** Accepted

**Decision:** A task represents required work; an attempt represents one execution of that work.

One task may have multiple attempts using different models.

---

### ADR-007 — Worktree-per-Task Isolation

**Status:** Accepted

**Decision:** Every concurrently executing task receives its own Git branch and worktree.

The orchestrator—not the agent—controls integration.

---

### ADR-008 — Integration Determines Completion

**Status:** Accepted

**Decision:** Passing verification inside a task worktree does not make a task `DONE`.

A task becomes `DONE` only after successful integration and required integration verification.

---

### ADR-009 — Provider-Agnostic Agent Runtime

**Status:** Accepted

**Decision:** The core talks to an abstract Agent Runtime.

Provider-specific behavior for Codex, OpenCode, Claude, Gemini, local models, etc. lives behind adapters.

Adapters explicitly advertise supported capabilities.

---

### ADR-010 — Deterministic Workflow Engine

**Status:** Accepted

**Decision:** Workflow stages and gates are controlled by the runner.

Agents execute stages but cannot redesign the workflow.

V0.1 workflows are configuration-driven rather than arbitrary executable plugins.

---

### ADR-011 — Bounded Roadmap

**Status:** Accepted

**Decision:** Autonomous execution operates only within a finite approved roadmap.

Every task requires explicit provenance such as:

- roadmap criterion
- user request
- blocker
- verification failure
- approved task split

Agents cannot silently create unrelated work.

---

### ADR-012 — Context Packs Instead of Repository Dumps

**Status:** Accepted

**Decision:** Every agent invocation receives a task-specific context pack containing mandatory, retrieved, and optionally requested context.

The exact context manifest is persisted for each attempt.

---

### ADR-013 — External Verification Is Authoritative

**Status:** Accepted

**Decision:** Agent claims such as "done" or "tests pass" are informational only.

The runner determines completion using configured verification evidence.

---

### ADR-014 — Rule-Based Routing First

**Status:** Accepted

**Decision:** V0.1 uses deterministic routing rules based on task type, complexity, risk, cost, and agent capability.

Historical adaptive routing is deferred until sufficient telemetry exists.

---

### ADR-015 — Cross-Platform by Design

**Status:** Accepted

**Decision:** macOS, Linux, and Windows are first-class platforms.

Core code must avoid assumptions about:

- Bash
- Unix paths
- Unix signals
- `/tmp`
- shell quoting
- executable extensions

OS-specific behavior must live behind platform abstractions.

---

### ADR-016 — Event-Driven Observability

**Status:** Accepted

**Decision:** Important state changes produce structured immutable events.

CLI and future GUI derive live progress from the same runtime state/event system.

---

### ADR-017 — Discovery Before Planning

**Status:** Accepted

**Decision:** Projects are assessed for readiness before roadmap generation.

Missing important decisions trigger guided discovery rather than silent assumptions.

Autonomous implementation cannot begin until the project reaches `READY_FOR_PLANNING`.

---

### ADR-018 — Single Local Engine for V0.1

**Status:** Accepted

**Decision:** Start with one local orchestrator process plus child agent processes.

Do not introduce distributed workers, brokers, Redis, or microservices yet.

Architecture boundaries should allow remote workers later without redesigning the domain model.

---

### ADR-019 — Durable Runner Control (D-AP-5)

**Status:** Provisional — Panel and CEO approved; owner confirmation pending.

**Decision:** Store per-project runner control in an additive SQLite STRICT table.
A missing row represents RUNNING. Pause and resume are idempotent transactional
changes, and task execution claims check the state within the same immediate
write transaction that acquires claims and locks. Task and integration queue
states remain unchanged. Existing admitted work is not interrupted.

**Delivery:** AR031 implements the persistence contract and claim gate. AR032 adds
coordinator admission and scheduler drain, preserving startup recovery. AR033 delivers
CLI control and atomic transition events, with direct execution admission gated.
Pause drains admitted work and does not interrupt in-flight agents.

---

### ADR-020 — Trustworthy Per-Invocation Usage Observation Contract (D-AP-6)

**Status:** PROVISIONAL — D-AP-6 (Panel unanimous 3–0, CEO approved; owner confirmation pending; AR037 evidence limits apply).

**Decision:** The runner records at most one neutral, provider-independent usage
observation per distinct invocation (stage run or separately identified
single-task invocation), validated by `packages/core/src/domain/invocation-usage.ts`.
The contract is provider-agnostic: it stores only what a provider reported
(exact provider-reported counter values with their own currency and provenance
for money) and explicit well-formedness statuses:

- `unknown` — nothing usable was reported (no result, crash gap, unusable
  output). Unknown is never zero.
- `partial` — some evidence reported, coverage incomplete.
- `complete` — the caller asserts full invocation coverage.
- `inconsistent` — reported values contradict; evidence is retained with
  required reasons and never repaired.

Counters are independently optional nonnegative safe integers
(input, output, reasoning, cache read, cache write, and a provider-reported
total only); omission is distinct from an explicit zero, cache counts are
labelled (`subset`/`independent` or absent for no claim) and never merged into
input. Money is an exact decimal string with verbatim provider-reported
currency and provenance; absent unless the provider explicitly reported it.
No prices, derived costs, inferred subscription costs or assumed currency are
invented at this layer, and per AR037 upstream may coerce missing usage to
zero, so no numeric observation is trusted without an approved provider
evidence model.

Validation is strict and safe: malformed values, unknown fields, unknown
statuses, future schema versions, and status/content contradictions return
null (never throw) and are rejected as evidence, never guessed around.

**Scope reconciliation (what this slice does NOT do — AR040+ slices):**
slice 1 adds only the observation contract, exports, validation and focused
compatibility tests. It does not persist observations (schema/migration belongs
to a later slice), wire observations into invocation creation, agent results,
stage finalizers or crash recovery, parse any provider output (adapter parsing
remains behind the adapter boundary per ADR-009), or render usage in any CLI
view (`inspect --usage` and any display are separate approved slices). Legacy
attempt `tokenUsage`/`cost` fields remain readable but unverified and are not
reinterpreted as trustworthy evidence. Planning invocations are excluded and
visibly documented in later slices per D-AP-6.

**Slice 2a — persistence (AR040):** SQLite migration v12 adds nullable
`stage_runs.usage_json` and `attempts.invocation_usage_json` (the latter for the
single-task invocation, distinct from the legacy `token_usage_json`/`cost`).
Observations are validated by `parseInvocationUsageObservation` before any write
and only the sanitized copy is stored; malformed, contradictory or
unsupported-version values throw and write nothing. Stored evidence that fails
validation on read (including a future observation `schemaVersion`) fails the
read with an explicit error and is never repaired, defaulted or rewritten. A
put that omits an observation preserves the stored one (no erase by omission);
rows with no observation load with no usage field. The migration is additive;
there is no backfill and no destructive rewrite, and an older runner opening a
v12 database is refused by the existing newer-schema check. The validator still
does not cross-check `totalTokens` against components: the caller sets
`inconsistent` (AR039 N3). Still out of scope: invocation wiring, finalizer and
crash-recovery propagation, adapter parsing, totals and CLI rendering
(AR041–AR044).

**Provisional immutability policy (AR049, Panel policy A, CEO approved):**
For a stable stage run or attempt identity, the first non-null observation is
immutable. Omission preserves it, and a semantically identical replay is allowed
regardless of object key order. A conflicting non-null observation is rejected
without changing any field of the row. Missing rows and null observations accept
the first observation. SQLite serializes the check and write across connections;
no migration or provider payload in error messages is introduced.

**Slice 2b — workflow invocation evidence (AR041):** Agent execution results
may carry an optional neutral observation. The PLAN, PLAN_REVIEW, IMPLEMENT,
and CODE_REVIEW workflow stage finalizers write returned observations with the
terminal stage run, including failed invocations and failures after a result.
An invocation that produces no result has no observation. Distinct review
cycles retain distinct stage-run evidence; recovery must preserve existing
evidence. The planning exclusion above means discovery and project planning,
not the workflow PLAN stage. This slice does not parse provider output, wire
single-task invocations, calculate totals, or render usage.

### ADR-021 — Version-Scoped OpenCode Read-Only Invocation Shapes (AR048)

**Status:** PROVISIONAL — adapter invocation contract for provider CLI major
versions; owner confirmation pending.

**Decision:** The OpenCode adapter invokes the installed `opencode` CLI in
read-only planning mode with a version-scoped argument shape, detected once
per adapter instance through a `--version` probe:

- **opencode 1.x (and any undetectable/failed probe):** the legacy shape
  `run --pure --agent <injected> --model <m>` continues to be used unchanged.
- **opencode 2.x:** `run --standalone --agent <injected> --model <m>`. 2.0
  removed `--pure` (live failure: "Unrecognized flag") and binds the run to a
  shared background server that never observes agents injected through
  `OPENCODE_CONFIG` (live failure: "Agent not found"); `--standalone` starts a
  private server for the run, which applies the injected agent definitions. This
  is documented CLI behavior in opencode 2.x ("Run with a private server
  instead of the background service").

**What does not change:** the read-only planning contract is identical across
versions. The per-invocation agent is injected through `OPENCODE_CONFIG` into a
temp directory with `permission: { edit, bash, task, skill }` all denied, the
agent id is unique per invocation, project OpenCode config is never overwritten,
and the temp directory is removed after the run. Non-read-only invocations
never probe the version and never receive `--agent`. The version probe is an
adapter-internal compatibility detail behind the adapter boundary (ADR-009);
the runner core remains unaffected.
