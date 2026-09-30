# Cheap-First Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each task to the cheapest available capable profile allowed by deterministic risk/complexity rules, escalate within the existing attempt budget, and make every decision inspectable.

**Architecture:** Add optional cost tiers to provider-agnostic profiles, derive a tier floor in pure core logic, and apply the same floor to scheduling admission and execution. One CLI application helper records the selected route for both single-task and unattended execution.

**Tech Stack:** TypeScript, Node.js, pnpm workspace, Vitest, existing `RunnerStore` and adapter availability registry.

**Spec:** `docs/superpowers/specs/2026-09-30-launch-planning-dogfood-design.md` (L011)

## Global Constraints

- Existing configs with no tier behave as `standard` and preserve configured-order ties.
- Capability and availability filters remain authoritative; no provider condition enters core.
- Tier escalation never adds attempts or exceeds `limits.maxAttempts`.
- No silent downgrade when no profile meets the minimum tier.
- Persist route evidence through existing immutable events; do not add a separate routing table.
- Add no production dependency.

## Review Focus

- Invalid profile tier → configuration error lists the three valid values.
- Untiered profiles → selection stays compatible and deterministic.
- Only a too-cheap profile is available → no route with an explicit below-minimum reason.
- Multiple failed attempts → floor rises one tier and caps at strong.
- Admission and actual execution → use the same tier calculation and attempt count.

---

### Task 1: Add optional profile tiers and validation

**Files:**
- Create: `packages/core/src/domain/agent-tier.ts`
- Modify: `packages/core/src/domain/agent-profile.ts`
- Modify: `packages/core/src/domain/project-config.ts`
- Modify: `packages/core/src/domain/index.ts`
- Test: `packages/core/test/agent-profile.test.ts`
- Test: `packages/core/test/project-config.test.ts`
- Test: `packages/config/test/project-config-file.test.ts`

**Interfaces:**
- Produces: `AgentTier = "economy" | "standard" | "strong"`, `profileTier(profile)`, and optional `AgentProfile.tier`.

- [ ] Add tests for all tiers, omitted-tier default, invalid tier rejection, and config round trip.
- [ ] Run focused core/config tests and confirm new cases fail.
- [ ] Implement tier type/order/default and strict YAML validation; preserve old config behavior.
- [ ] Run focused tests and existing routing/config suites.

### Task 2: Derive tier floors and route candidates deterministically

**Files:**
- Create: `packages/core/src/domain/routing-policy.ts`
- Modify: `packages/core/src/domain/agent-router.ts`
- Modify: `packages/core/src/domain/task-selection.ts`
- Modify: `packages/core/src/domain/index.ts`
- Test: `packages/core/test/routing-policy.test.ts`
- Modify: `packages/core/test/agent-router.test.ts`
- Modify: `packages/core/test/task-selection.test.ts`

**Interfaces:**
- Produces: `requiredTierFor(task, priorFailedAttempts)` and tier-aware `selectAgentProfile` with structured `below-minimum-tier` rejection.
- Policy: large/high/critical → strong; medium complexity or risk → standard; otherwise economy; each prior failure raises one tier, capped at strong.

- [ ] Add tests for tier floor, escalation/cap, cheapest capable selection, configured-order ties, rejection diagnostics, and scheduling admission parity.
- [ ] Run focused core tests and confirm new cases fail.
- [ ] Implement pure policy and filter logic; preserve availability/capability precedence and return no route rather than downgrade.
- [ ] Run focused tests plus existing router, task-selection, and parallelism tests.

### Task 3: Use one routing helper for both execution paths and persist decisions

**Files:**
- Create: `packages/cli/src/application/agents/task-routing.ts`
- Modify: `packages/cli/src/application/agents/agent-routing.ts`
- Modify: `packages/cli/src/application/agents/routed-task-orchestrator.ts`
- Modify: `packages/cli/src/application/app-services.ts`
- Create: `packages/cli/test/task-routing.test.ts`
- Modify: `packages/cli/test/routed-task-orchestrator.test.ts`
- Modify: `packages/cli/test/routed-run-e2e.test.ts`

**Interfaces:**
- Produces: `routeTaskAttempt({ task, store, agentProfiles, agents, adapters })`, which reads prior attempts, applies `requiredTierFor`, resolves a runtime, and writes `task.routing.decided` with profile, selected/minimum tier, count, and reason.

- [ ] Add tests proving both execution paths route by the same persisted attempt count and successful selection writes exactly one durable event.
- [ ] Run focused CLI routing tests and confirm new cases fail.
- [ ] Implement the helper and replace direct profile selection in both paths; keep store access in application code.
- [ ] Run focused tests and existing routed-run/workflow E2E tests.

### Task 4: Show routing decisions and document tier configuration

**Files:**
- Modify: `packages/cli/src/render/render-inspect.ts`
- Modify: `packages/cli/test/run-cli.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `task.routing.decided` event from Task 3.
- Produces: a readable inspect line with selected profile/tier and reason; README documents tier behavior and bounded escalation.

- [ ] Add an inspect assertion for a valid routing event and safe behavior for malformed/old event payloads.
- [ ] Run the focused CLI render test and confirm it fails.
- [ ] Render routing events in event order and document economy/standard/strong configuration plus retry limits.
- [ ] Run the inspect/CLI tests and `pnpm --filter @agentic-dev-runner/cli typecheck`.

### Task 5: Run routing workstream checks

**Files:** No new files.

- [ ] Run focused core/config/CLI suites for changed modules.
- [ ] Run workspace `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`; fix failures in this workstream before handoff.

