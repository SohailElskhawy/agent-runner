# P1 — Cheap-First Routing and Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each task to the cheapest capable agent profile that its complexity and risk allow. Escalate one tier per failed attempt, within the existing attempt budget, and record every routing decision as an inspectable event.

**Architecture:**
- Profiles gain an optional `tier` (`economy | standard | strong`, default `standard`).
- A new pure core module maps task complexity and risk plus prior attempt count to a required minimum tier.
- The pure core router gains a tier floor and a cheapest-first preference. Capability and availability rules are unchanged and still take precedence.
- A single CLI-application helper computes the tier, routes the task, and persists a `task.routing.decided` event. Both execution paths (single-task and unattended) call it.

**Tech Stack:** TypeScript (strict), Node 24, pnpm workspaces, vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-planning-routing-adapters-v0.1-design.md` (section P1)

## Global Constraints

- Core stays pure: no persistence, processes, or provider names in `packages/core`.
- No `if provider == …` outside adapter boundaries.
- Existing configs without `tier` must behave exactly as before. Every profile counts as `standard`, so configured order still breaks ties.
- Escalation never creates attempts. `limits.maxAttempts` stays authoritative.
- No silent downgrade: when no profile meets the minimum tier, the result is no-route with diagnostics.
- Readable open-source code: small modules, doc comment at the top of each new module, no duplication.
- Per-package test command: `pnpm --filter <package> exec vitest run <file>`. Final check: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.

## Review Focus

1. **Configs with no `tier` anywhere.** Routing must be identical to today: first eligible profile in config order. Covered in Task 3 (existing router tests stay green, plus an explicit test).
2. **Escalation past `strong`.** A third failed attempt on an economy task requires `strong` (capped). It must never overflow or wrap around. Covered in Task 2.
3. **Only an economy profile configured, but the task needs `standard`.** The result must be no-route with a readable reason, never silently using economy. Covered in Tasks 3 and 4.
4. **Invalid tier in YAML (`tier: cheap`).** Config validation must fail with a clear message naming the allowed values. Covered in Task 1.
5. **Admission and execution disagree.** The scheduler admits using the same tier rule as execution, so a task is never admitted and then rejected for tier. Covered in Task 3 (task-selection passes the same required tier).

---

## File Structure

| File | Responsibility |
|---|---|
| Create `packages/core/src/domain/agent-tier.ts` | Tier values, ordering, the default tier |
| Modify `packages/core/src/domain/agent-profile.ts` | Accept and validate optional `tier` |
| Create `packages/core/src/domain/routing-policy.ts` | Task → minimum tier, escalation, reason text |
| Modify `packages/core/src/domain/agent-router.ts` | Tier floor + cheapest-first selection |
| Modify `packages/core/src/domain/task-selection.ts` | Admission uses the required tier |
| Modify `packages/core/src/domain/index.ts` | Export the new modules |
| Modify `packages/cli/src/application/agents/agent-routing.ts` | Pass `minimumTier`; describe tier rejections |
| Create `packages/cli/src/application/agents/task-routing.ts` | Compute tier + route + persist the decision event |
| Modify `packages/cli/src/application/agents/routed-task-orchestrator.ts` | Use `routeTaskAttempt` |
| Modify `packages/cli/src/application/app-services.ts` | Use `routeTaskAttempt` in the unattended executor factory |
| Modify `README.md` | Document tiers and escalation |

---

### Task 1: Agent tiers on profiles

**Files:**
- Create: `packages/core/src/domain/agent-tier.ts`
- Modify: `packages/core/src/domain/agent-profile.ts`
- Modify: `packages/core/src/domain/index.ts`
- Test: `packages/core/test/agent-profile.test.ts`, `packages/core/test/project-config.test.ts`

**Interfaces:**
- Produces:
  - `AGENT_TIERS`
  - `type AgentTier = "economy" | "standard" | "strong"`
  - `DEFAULT_AGENT_TIER`
  - `profileTier(profile: AgentProfile): AgentTier`
  - `compareTiers(a: AgentTier, b: AgentTier): number` (negative when `a` is cheaper)
  - `AgentProfile.tier?: AgentTier`

- [ ] **Step 1: Write failing tests** (append to `packages/core/test/agent-profile.test.ts`)

```ts
import {
  compareTiers,
  profileTier,
  validateAgentProfile,
} from "@agentic-dev-runner/core";

describe("agent profile tiers", () => {
  it("accepts an explicit tier", () => {
    const result = validateAgentProfile({
      id: "cheap", adapterId: "opencode", capabilities: [], tier: "economy",
    });
    expect(result).toEqual({
      ok: true,
      value: { id: "cheap", adapterId: "opencode", capabilities: [], tier: "economy" },
    });
  });

  it("leaves tier unset when omitted and treats it as standard", () => {
    const result = validateAgentProfile({ id: "p", adapterId: "codex", capabilities: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tier).toBeUndefined();
    expect(profileTier(result.value)).toBe("standard");
  });

  it("rejects an unknown tier and names the allowed values", () => {
    const result = validateAgentProfile({
      id: "p", adapterId: "codex", capabilities: [], tier: "cheap",
    });
    expect(result).toEqual({
      ok: false,
      issues: ['agent profile.tier: must be one of "economy", "standard", "strong"'],
    });
  });

  it("orders tiers from cheapest to strongest", () => {
    expect(compareTiers("economy", "standard")).toBeLessThan(0);
    expect(compareTiers("strong", "standard")).toBeGreaterThan(0);
    expect(compareTiers("standard", "standard")).toBe(0);
  });
});
```

Also append to `packages/core/test/project-config.test.ts` inside `describe("validateProjectConfiguration agent profiles", …)`. Reuse the file's existing canonical config builder; `canonicalAgents()` is at line 259.

```ts
it("passes a YAML tier through to the profile", () => {
  const input = canonicalAgents();
  const profiles = (input.agents as { profiles: Record<string, Record<string, unknown>> }).profiles;
  const firstId = Object.keys(profiles)[0] as string;
  profiles[firstId] = { ...profiles[firstId], tier: "economy" };
  const result = validateProjectConfiguration(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.agentProfiles[0]?.tier).toBe("economy");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @agentic-dev-runner/core exec vitest run test/agent-profile.test.ts test/project-config.test.ts`
Expected: FAIL. `compareTiers`/`profileTier` are not exported, and `tier` is rejected as an unknown field.

- [ ] **Step 3: Create `packages/core/src/domain/agent-tier.ts`**

```ts
/**
 * Agent cost tiers.
 *
 * A tier is a user-declared label on an agent profile describing how
 * expensive (and, usually, how capable) the profile's model is. The runner
 * never knows prices or provider names; it only compares tiers. Profiles
 * without a declared tier are treated as `standard` so configurations written
 * before tiers existed keep their behavior.
 */

import type { AgentProfile } from "./agent-profile.js";

/** Ordered from cheapest to strongest. */
export const AGENT_TIERS = ["economy", "standard", "strong"] as const;

export type AgentTier = (typeof AGENT_TIERS)[number];

export const DEFAULT_AGENT_TIER: AgentTier = "standard";

export function isAgentTier(value: unknown): value is AgentTier {
  return typeof value === "string" && (AGENT_TIERS as readonly string[]).includes(value);
}

export function profileTier(profile: AgentProfile): AgentTier {
  return profile.tier ?? DEFAULT_AGENT_TIER;
}

/** Negative when `a` is cheaper than `b`, zero when equal, positive otherwise. */
export function compareTiers(a: AgentTier, b: AgentTier): number {
  return AGENT_TIERS.indexOf(a) - AGENT_TIERS.indexOf(b);
}
```

- [ ] **Step 4: Extend `packages/core/src/domain/agent-profile.ts`**

Add the import and the field:

```ts
import type { AgentTier } from "./agent-tier.js";
import { AGENT_TIERS, isAgentTier } from "./agent-tier.js";

export type AgentProfile = {
  readonly id: string;
  readonly adapterId: string;
  readonly model?: string | undefined;
  /** Cost tier; omitted means `standard` (see `profileTier`). */
  readonly tier?: AgentTier | undefined;
  readonly capabilities: readonly string[];
};
```

Add `"tier"` to `AGENT_PROFILE_KEYS`. In `validateAgentProfile`, after `const capabilities = …`, add:

```ts
  const tier = requireOptionalTier(input, issues);
```

Replace the success `return` with a builder that omits unset optionals:

```ts
  return {
    ok: true,
    value: {
      id: defined(id),
      adapterId: defined(adapterId),
      ...(model === undefined ? {} : { model }),
      ...(tier === undefined ? {} : { tier }),
      capabilities: defined(capabilities),
    },
  };
```

Add a helper next to `requireOptionalNonEmptyString`:

```ts
function requireOptionalTier(
  source: Record<string, unknown>,
  issues: string[],
): AgentTier | undefined {
  const value = source["tier"];
  if (value === undefined) {
    return undefined;
  }
  if (!isAgentTier(value)) {
    const allowed = AGENT_TIERS.map((tier) => `"${tier}"`).join(", ");
    issues.push(`${fieldPath("tier")}: must be one of ${allowed}`);
    return undefined;
  }
  return value;
}
```

In `packages/core/src/domain/index.ts`, add `export * from "./agent-tier.js";` after the `agent-profile` line.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @agentic-dev-runner/core exec vitest run`
Expected: PASS (all core tests, including the existing profile tests, which prove the `toEqual` shapes are unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/domain/agent-tier.ts packages/core/src/domain/agent-profile.ts packages/core/src/domain/index.ts packages/core/test/agent-profile.test.ts packages/core/test/project-config.test.ts
git commit -m "feat(core): add optional cost tier to agent profiles"
```

---

### Task 2: Routing policy (task → required tier)

**Files:**
- Create: `packages/core/src/domain/routing-policy.ts`
- Modify: `packages/core/src/domain/index.ts`
- Test: `packages/core/test/routing-policy.test.ts`

**Interfaces:**
- Consumes: `AgentTier`, `AGENT_TIERS` (Task 1); `TaskComplexity`, `TaskRisk` (`task-contract.ts`)
- Produces:
  - `minimumTierFor(complexity: TaskComplexity, risk: TaskRisk): AgentTier`
  - `escalatedTier(minimum: AgentTier, priorAttempts: number): AgentTier`
  - `type RequiredTier = { readonly tier: AgentTier; readonly baseTier: AgentTier; readonly priorAttempts: number; readonly reason: string }`
  - `requiredTierFor(task: Pick<Task, "risk" | "routing">, priorAttempts: number): RequiredTier`

- [ ] **Step 1: Write the failing test** `packages/core/test/routing-policy.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  escalatedTier,
  minimumTierFor,
  requiredTierFor,
} from "@agentic-dev-runner/core";

describe("minimumTierFor", () => {
  it.each([
    ["trivial", "low", "economy"],
    ["small", "low", "economy"],
    ["medium", "low", "standard"],
    ["small", "medium", "standard"],
    ["large", "low", "strong"],
    ["trivial", "high", "strong"],
    ["small", "critical", "strong"],
  ] as const)("complexity=%s risk=%s → %s", (complexity, risk, tier) => {
    expect(minimumTierFor(complexity, risk)).toBe(tier);
  });
});

describe("escalatedTier", () => {
  it("keeps the minimum when there are no prior attempts", () => {
    expect(escalatedTier("economy", 0)).toBe("economy");
  });

  it("raises one tier per prior attempt", () => {
    expect(escalatedTier("economy", 1)).toBe("standard");
    expect(escalatedTier("economy", 2)).toBe("strong");
  });

  it("caps at strong", () => {
    expect(escalatedTier("economy", 7)).toBe("strong");
    expect(escalatedTier("strong", 1)).toBe("strong");
  });
});

describe("requiredTierFor", () => {
  const task = { risk: "low", routing: { complexity: "small", capabilities: [] } } as const;

  it("explains a first attempt", () => {
    expect(requiredTierFor(task, 0)).toEqual({
      tier: "economy",
      baseTier: "economy",
      priorAttempts: 0,
      reason: "complexity=small, risk=low requires economy",
    });
  });

  it("explains an escalation", () => {
    expect(requiredTierFor(task, 1)).toEqual({
      tier: "standard",
      baseTier: "economy",
      priorAttempts: 1,
      reason: "complexity=small, risk=low requires economy; escalated to standard after 1 prior attempt",
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @agentic-dev-runner/core exec vitest run test/routing-policy.test.ts`
Expected: FAIL (the functions are not exported).

- [ ] **Step 3: Create `packages/core/src/domain/routing-policy.ts`**

```ts
/**
 * Cheap-first routing policy.
 *
 * Decides the minimum agent tier a task attempt may run on:
 * - high/critical risk or large complexity → strong
 * - medium complexity or medium risk       → standard
 * - everything else                        → economy
 *
 * Each prior attempt of the task (a task is only re-run after a failed
 * attempt) raises the minimum by one tier, capped at `strong`. Escalation
 * only changes which profile runs the next attempt; the task's attempt
 * budget still bounds how many attempts exist.
 */

import type { AgentTier } from "./agent-tier.js";
import { AGENT_TIERS } from "./agent-tier.js";
import type { TaskComplexity, TaskRisk } from "./task-contract.js";
import type { Task } from "./task.js";

export type RequiredTier = {
  readonly tier: AgentTier;
  readonly baseTier: AgentTier;
  readonly priorAttempts: number;
  /** Human-readable explanation shown by `agentic inspect`. */
  readonly reason: string;
};

export function minimumTierFor(complexity: TaskComplexity, risk: TaskRisk): AgentTier {
  if (risk === "high" || risk === "critical" || complexity === "large") {
    return "strong";
  }
  if (risk === "medium" || complexity === "medium") {
    return "standard";
  }
  return "economy";
}

export function escalatedTier(minimum: AgentTier, priorAttempts: number): AgentTier {
  const index = AGENT_TIERS.indexOf(minimum) + Math.max(0, priorAttempts);
  return AGENT_TIERS[Math.min(index, AGENT_TIERS.length - 1)] ?? "strong";
}

export function requiredTierFor(
  task: Pick<Task, "risk" | "routing">,
  priorAttempts: number,
): RequiredTier {
  const { complexity } = task.routing;
  const baseTier = minimumTierFor(complexity, task.risk);
  const tier = escalatedTier(baseTier, priorAttempts);
  const base = `complexity=${complexity}, risk=${task.risk} requires ${baseTier}`;
  const reason =
    tier === baseTier
      ? base
      : `${base}; escalated to ${tier} after ${priorAttempts} prior ${priorAttempts === 1 ? "attempt" : "attempts"}`;
  return { tier, baseTier, priorAttempts, reason };
}
```

Add `export * from "./routing-policy.js";` to `packages/core/src/domain/index.ts` after `agent-tier`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @agentic-dev-runner/core exec vitest run test/routing-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain/routing-policy.ts packages/core/src/domain/index.ts packages/core/test/routing-policy.test.ts
git commit -m "feat(core): add cheap-first routing policy with bounded escalation"
```

---

### Task 3: Tier floor and cheapest-first in the router and admission

**Files:**
- Modify: `packages/core/src/domain/agent-router.ts`
- Modify: `packages/core/src/domain/task-selection.ts:143-150`
- Test: `packages/core/test/agent-router.test.ts`, `packages/core/test/task-selection.test.ts`

**Interfaces:**
- Consumes: `profileTier`, `compareTiers`, `AgentTier` (Task 1); `requiredTierFor` (Task 2)
- Produces:
  - `AgentRouteRequest.minimumTier?: AgentTier` (omitted means no floor)
  - A new `AgentRouteRejection` variant: `{ reason: "below-minimum-tier"; profileId: string; profileTier: AgentTier; minimumTier: AgentTier }`

- [ ] **Step 1: Write failing router tests** (append to `packages/core/test/agent-router.test.ts`, reusing its `profile`/`candidate` helpers)

```ts
describe("selectAgentProfile tiers", () => {
  const economy = candidate({ profile: profile({ id: "cheap", tier: "economy" }) });
  const standard = candidate({ profile: profile({ id: "mid", tier: "standard" }) });
  const strong = candidate({ profile: profile({ id: "big", tier: "strong" }) });

  it("prefers the cheapest eligible tier regardless of configured order", () => {
    const result = selectAgentProfile({ requiredCapabilities: [], candidates: [strong, standard, economy] });
    expect(result.selected && result.profile.id).toBe("cheap");
  });

  it("uses configured order to break ties inside a tier", () => {
    const first = candidate({ profile: profile({ id: "first" }) });
    const second = candidate({ profile: profile({ id: "second" }) });
    const result = selectAgentProfile({ requiredCapabilities: [], candidates: [first, second] });
    expect(result.selected && result.profile.id).toBe("first");
  });

  it("skips profiles below the minimum tier", () => {
    const result = selectAgentProfile({
      requiredCapabilities: [], candidates: [economy, strong, standard], minimumTier: "standard",
    });
    expect(result.selected && result.profile.id).toBe("mid");
  });

  it("returns no-route instead of downgrading when nothing meets the minimum", () => {
    const result = selectAgentProfile({
      requiredCapabilities: [], candidates: [economy], minimumTier: "strong",
    });
    expect(result).toEqual({
      selected: false,
      rejections: [{
        reason: "below-minimum-tier", profileId: "cheap", profileTier: "economy", minimumTier: "strong",
      }],
    });
  });

  it("reports an unavailable adapter before a tier mismatch", () => {
    const result = selectAgentProfile({
      requiredCapabilities: [],
      candidates: [candidate({
        profile: profile({ id: "cheap", tier: "economy" }),
        availability: { id: "cheap", available: false },
      })],
      minimumTier: "strong",
    });
    expect(result).toEqual({
      selected: false,
      rejections: [{ reason: "adapter-unavailable", profileId: "cheap" }],
    });
  });
});
```

Append to `packages/core/test/task-selection.test.ts`. Reuse that file's existing task/candidate builders; if its builders differ in name, adapt only the helper names.

```ts
it("does not admit a task whose escalated tier no configured profile meets", () => {
  const task = readyTask({ id: "T1" }); // small/low → economy on the first attempt
  const selection = selectRunnableTasks({
    tasks: [task],
    attemptCounts: new Map([["T1", 1]]), // one prior attempt → standard required
    agentCandidates: [candidate({ profile: profile({ id: "cheap", tier: "economy" }) })],
  });
  expect(selection.runnable).toEqual([]);
  expect(selection.ineligible[0]?.ineligibility.reason).toBe("no-eligible-agent");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @agentic-dev-runner/core exec vitest run test/agent-router.test.ts test/task-selection.test.ts`
Expected: FAIL (configured order wins today, `minimumTier` is ignored, and the task is admitted).

- [ ] **Step 3: Update `packages/core/src/domain/agent-router.ts`**

Update the module doc comment's rule 2 to: "Among the remaining candidates, the cheapest tier wins (see `agent-tier.ts`); candidates below `minimumTier` are rejected." Then:

```ts
import type { AgentTier } from "./agent-tier.js";
import { compareTiers, profileTier } from "./agent-tier.js";

export type AgentRouteRequest = {
  readonly requiredCapabilities: readonly string[];
  readonly candidates: readonly AgentRouteCandidate[];
  /** Lowest tier allowed for this attempt; omitted means any tier. */
  readonly minimumTier?: AgentTier | undefined;
};

// add to the AgentRouteRejection union:
  | {
      readonly reason: "below-minimum-tier";
      readonly profileId: string;
      readonly profileTier: AgentTier;
      readonly minimumTier: AgentTier;
    };

export function selectAgentProfile(request: AgentRouteRequest): AgentRouteResult {
  const rejections: AgentRouteRejection[] = [];
  let cheapest: AgentProfile | undefined;

  for (const candidate of request.candidates) {
    const rejection = rejectionFor(candidate, request);
    if (rejection !== undefined) {
      rejections.push(rejection);
      continue;
    }
    // Strictly-cheaper comparison keeps the first candidate within a tier.
    if (
      cheapest === undefined ||
      compareTiers(profileTier(candidate.profile), profileTier(cheapest)) < 0
    ) {
      cheapest = candidate.profile;
    }
  }

  return cheapest === undefined
    ? { selected: false, rejections }
    : { selected: true, profile: cheapest };
}

function rejectionFor(
  candidate: AgentRouteCandidate,
  request: AgentRouteRequest,
): AgentRouteRejection | undefined {
  const profileId = candidate.profile.id;
  if (!candidate.availability.available) {
    return { reason: "adapter-unavailable", profileId };
  }
  const eligibility = evaluateAgentProfileEligibility(
    candidate.profile,
    request.requiredCapabilities,
  );
  if (!eligibility.eligible) {
    return {
      reason: "missing-capabilities",
      profileId,
      missingCapabilities: eligibility.missingCapabilities,
    };
  }
  const tier = profileTier(candidate.profile);
  if (request.minimumTier !== undefined && compareTiers(tier, request.minimumTier) < 0) {
    return {
      reason: "below-minimum-tier",
      profileId,
      profileTier: tier,
      minimumTier: request.minimumTier,
    };
  }
  return undefined;
}
```

- [ ] **Step 4: Update admission in `packages/core/src/domain/task-selection.ts`**

Add `import { requiredTierFor } from "./routing-policy.js";` and replace the route call:

```ts
  const route = selectAgentProfile({
    requiredCapabilities: task.routing.capabilities,
    candidates: input.agentCandidates,
    minimumTier: requiredTierFor(task, attempts).tier,
  });
```

Add one sentence to that module's doc comment: "Admission applies the same cheap-first tier floor as execution (`requiredTierFor`), using the persisted attempt count."

- [ ] **Step 5: Run the core tests and confirm they pass**

Run: `pnpm --filter @agentic-dev-runner/core exec vitest run`
Expected: PASS, including every existing router and selection test. Untiered fixtures all count as `standard`, and the fixture tasks are small/low (economy floor), so standard profiles are still admitted.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/domain/agent-router.ts packages/core/src/domain/task-selection.ts packages/core/test/agent-router.test.ts packages/core/test/task-selection.test.ts
git commit -m "feat(core): route cheapest eligible tier with a minimum-tier floor"
```

---

### Task 4: Route attempts through one helper and persist the decision

**Files:**
- Modify: `packages/cli/src/application/agents/agent-routing.ts`
- Create: `packages/cli/src/application/agents/task-routing.ts`
- Modify: `packages/cli/src/application/agents/routed-task-orchestrator.ts:100-105`
- Modify: `packages/cli/src/application/app-services.ts:189-197`
- Test: `packages/cli/test/task-routing.test.ts`, `packages/cli/test/agent-routing.test.ts`

**Interfaces:**
- Consumes: `requiredTierFor`, `AgentTier`, `profileTier` (core); `resolveRoutedAgent` (existing)
- Produces:
  - `ResolveRoutedAgentInput.minimumTier?: AgentTier`
  - `TASK_ROUTING_DECIDED_EVENT = "task.routing.decided"`
  - `routeTaskAttempt(input: { task: Task; store: RunnerStore; agentProfiles: readonly AgentProfile[]; agents: AgentRegistry; adapters: AgentAdapterRegistry; now?: () => string }): Promise<RoutedAgentSelection>`
  - Event payload: `{ profileId: string; adapterId: string; tier: AgentTier; minimumTier: AgentTier; priorAttempts: number; reason: string }`

- [ ] **Step 1: Write failing tests**

Append to `packages/cli/test/agent-routing.test.ts` (uses that file's `routing` helper; extend the helper's input type with `minimumTier?: AgentTier` and pass it through):

```ts
it("explains a tier rejection in the no-route reason", async () => {
  const selection = await routing({
    requiredCapabilities: ["typescript"],
    profiles: [{ ...opencodeProfile, tier: "economy" }],
    minimumTier: "strong",
  });
  expect(selection).toEqual({
    routed: false,
    reason:
      'no eligible agent profile: profile "opencode-profile" has tier "economy" but this attempt requires at least "strong"',
  });
});
```

Create `packages/cli/test/task-routing.test.ts`. Copy the `RecordingStore` class from `routed-task-orchestrator.test.ts` into a shared `packages/cli/test/recording-store.ts`, export it, and import it from both test files. This extraction avoids a third copy.

```ts
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@agentic-dev-runner/core";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import {
  routeTaskAttempt,
  TASK_ROUTING_DECIDED_EVENT,
} from "../src/application/agents/task-routing.js";
import { createFixtureAttempt, createFixtureTask } from "./fixtures.js";
import { RecordingStore } from "./recording-store.js";

const cheap: AgentProfile = { id: "cheap", adapterId: "opencode", tier: "economy", capabilities: ["typescript"] };
const mid: AgentProfile = { id: "mid", adapterId: "codex", tier: "standard", capabilities: ["typescript"] };

const agents: AgentRegistry = {
  agentIds: ["opencode", "codex"],
  discoverAgents: async () => [
    { id: "opencode", available: true, version: null, reason: null },
    { id: "codex", available: true, version: null, reason: null },
  ],
};

function route(store: RecordingStore) {
  return routeTaskAttempt({
    task: createFixtureTask(), // small / low risk
    store,
    agentProfiles: [mid, cheap],
    agents,
    adapters: createAgentAdapterRegistry([
      { descriptor: { id: "opencode" }, invoke: async () => { throw new Error("not invoked"); } },
      { descriptor: { id: "codex" }, invoke: async () => { throw new Error("not invoked"); } },
    ]),
    now: () => "2026-09-28T00:00:00.000Z",
  });
}

describe("routeTaskAttempt", () => {
  it("routes a first attempt to the economy profile and records why", async () => {
    const store = new RecordingStore();
    const selection = await route(store);

    expect(selection.routed && selection.profile.id).toBe("cheap");
    expect(store.events).toEqual([{
      type: TASK_ROUTING_DECIDED_EVENT,
      taskId: "M001",
      occurredAt: "2026-09-28T00:00:00.000Z",
      payload: {
        profileId: "cheap",
        adapterId: "opencode",
        tier: "economy",
        minimumTier: "economy",
        priorAttempts: 0,
        reason: "complexity=small, risk=low requires economy",
      },
    }]);
  });

  it("escalates to the standard profile after a failed attempt", async () => {
    const store = new RecordingStore();
    store.attempts.push(createFixtureAttempt({ status: "FAILED" }));
    const selection = await route(store);

    expect(selection.routed && selection.profile.id).toBe("mid");
    expect(store.events[0]?.payload).toMatchObject({
      tier: "standard",
      minimumTier: "standard",
      priorAttempts: 1,
      reason: "complexity=small, risk=low requires economy; escalated to standard after 1 prior attempt",
    });
  });

  it("records nothing when no profile can route the attempt", async () => {
    const store = new RecordingStore();
    store.attempts.push(createFixtureAttempt({ number: 1 }), createFixtureAttempt({ number: 2 }));
    const selection = await routeTaskAttempt({
      task: createFixtureTask(),
      store,
      agentProfiles: [cheap],
      agents,
      adapters: createAgentAdapterRegistry([
        { descriptor: { id: "opencode" }, invoke: async () => { throw new Error("not invoked"); } },
      ]),
    });
    expect(selection.routed).toBe(false);
    expect(store.events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @agentic-dev-runner/cli exec vitest run test/task-routing.test.ts test/agent-routing.test.ts`
Expected: FAIL (`task-routing.js` does not exist, and `minimumTier` isn't passed through).

- [ ] **Step 3: Extend `agent-routing.ts`**

Add `readonly minimumTier?: AgentTier | undefined;` to `ResolveRoutedAgentInput` (import `AgentTier` from core). Pass `minimumTier: input.minimumTier` into `selectAgentProfile`. In `describeNoRoute`, handle the new variant before the capability branch:

```ts
    if (rejection.reason === "below-minimum-tier") {
      return `profile "${rejection.profileId}" has tier "${rejection.profileTier}" but this attempt requires at least "${rejection.minimumTier}"`;
    }
```

- [ ] **Step 4: Create `packages/cli/src/application/agents/task-routing.ts`**

```ts
/**
 * Routes one task attempt and records why.
 *
 * This is the single entry point both execution paths (single-task `run` and
 * the unattended scheduler) use to pick an agent. It derives the required
 * tier from the task and its persisted attempt count (cheap-first with
 * escalation, see core `routing-policy.ts`), delegates selection to
 * `resolveRoutedAgent`, and appends a `task.routing.decided` event so
 * `agentic inspect` can explain the choice.
 */

import type { AgentProfile, Task } from "@agentic-dev-runner/core";
import { profileTier, requiredTierFor } from "@agentic-dev-runner/core";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import type { RoutedAgentSelection } from "./agent-routing.js";
import { resolveRoutedAgent } from "./agent-routing.js";

export const TASK_ROUTING_DECIDED_EVENT = "task.routing.decided";

export type RouteTaskAttemptInput = {
  readonly task: Task;
  readonly store: RunnerStore;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agents: AgentRegistry;
  readonly adapters: AgentAdapterRegistry;
  readonly now?: (() => string) | undefined;
};

export async function routeTaskAttempt(
  input: RouteTaskAttemptInput,
): Promise<RoutedAgentSelection> {
  const priorAttempts = (await input.store.listAttempts({ taskId: input.task.id })).length;
  const required = requiredTierFor(input.task, priorAttempts);
  const selection = await resolveRoutedAgent({
    requiredCapabilities: input.task.routing.capabilities,
    agentProfiles: input.agentProfiles,
    agents: input.agents,
    adapters: input.adapters,
    minimumTier: required.tier,
  });
  if (!selection.routed) {
    return selection;
  }
  await input.store.appendEvents([{
    type: TASK_ROUTING_DECIDED_EVENT,
    taskId: input.task.id,
    occurredAt: (input.now ?? (() => new Date().toISOString()))(),
    payload: {
      profileId: selection.profile.id,
      adapterId: selection.profile.adapterId,
      tier: profileTier(selection.profile),
      minimumTier: required.tier,
      priorAttempts,
      reason: required.reason,
    },
  }]);
  return selection;
}
```

- [ ] **Step 5: Switch both callers to `routeTaskAttempt`**

In `routed-task-orchestrator.ts`, replace the `resolveRoutedAgent({...})` call (lines 100–105) with:

```ts
    const selection = await routeTaskAttempt({
      task,
      store: this.store,
      agentProfiles: this.agentProfiles,
      agents: this.agents,
      adapters: this.adapters,
    });
```

Change its import to `import { routeTaskAttempt } from "./task-routing.js";`, and add "3. select a profile by cheap-first tier and record the decision" to the doc comment's routing order.

In `app-services.ts` (lines 189–197), inside `createExecutor`, replace the call the same way (`task`, `store`, `agentProfiles`, `agents`, `adapters`). Replace the `resolveRoutedAgent` import with `routeTaskAttempt` from `./agents/task-routing.js`.

- [ ] **Step 6: Run the CLI tests and confirm they pass**

Run: `pnpm --filter @agentic-dev-runner/cli exec vitest run`
Expected: PASS. The e2e suites use untiered profiles (all `standard`) and small/low tasks, so the selected profiles are unchanged. Each run now also records a `task.routing.decided` event. If an e2e test asserts an exact full event list, add the new event to its expectation. That change is intended behavior; note it in the commit.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/application/agents packages/cli/src/application/app-services.ts packages/cli/test
git commit -m "feat(cli): route attempts cheap-first and record routing decisions"
```

---

### Task 5: Show routing decisions in inspect and document tiers

**Files:**
- Modify: `packages/cli/src/render/` (the inspect renderer; find it with `grep -rn "inspect" packages/cli/src/render`)
- Modify: `README.md` (the `agents:` configuration section near line 258 and the command table near line 183)
- Test: the existing inspect render test file (find it with `grep -rln "renderInspect\|inspect" packages/cli/test`)

**Interfaces:**
- Consumes: `TASK_ROUTING_DECIDED_EVENT` and the payload (Task 4)

- [ ] **Step 1: Write a failing render test**

In the inspect render test, add a case whose inspection view includes one event `{ type: "task.routing.decided", payload: { profileId: "cheap", tier: "economy", minimumTier: "economy", priorAttempts: 0, reason: "complexity=small, risk=low requires economy" } }`. Assert the rendered output contains this line:

```text
routing: cheap (economy) — complexity=small, risk=low requires economy
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @agentic-dev-runner/cli exec vitest run <inspect render test file>`
Expected: FAIL (the line is absent).

- [ ] **Step 3: Implement the rendering**

In the inspect renderer, add a small function next to the existing event rendering:

```ts
function renderRoutingDecision(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { profileId, tier, reason } = payload as Record<string, unknown>;
  if (typeof profileId !== "string" || typeof tier !== "string" || typeof reason !== "string") {
    return null;
  }
  return `routing: ${profileId} (${tier}) — ${reason}`;
}
```

Call it for each event whose `type === TASK_ROUTING_DECIDED_EVENT`, in event order, and print the line under the attempts section. Malformed payloads return `null` and are skipped. Events stay durable, and inspect must never crash on old data.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @agentic-dev-runner/cli exec vitest run`
Expected: PASS

- [ ] **Step 5: Update the README**

In the `agents:` YAML example, add `tier: economy` to the profile and a second profile with `tier: strong`. Under the bullet list, add:

```markdown
- `tier` (optional): `economy`, `standard` (default), or `strong`. The runner
  sends each task to the cheapest available, capable profile allowed by the
  task's complexity and risk:
  - small or trivial, low risk → economy
  - medium complexity or medium risk → standard
  - large complexity or high/critical risk → strong

  Each failed attempt moves the next attempt up one tier, within
  `limits.max_attempts`. The runner never falls back to a cheaper tier;
  if no profile qualifies, the task is reported as unroutable.
  `agentic inspect <task-id>` shows every routing decision and its reason.
```

- [ ] **Step 6: Full verification**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. If anything fails, fix it before committing. Don't skip it.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/render packages/cli/test README.md
git commit -m "feat(cli): show routing decisions in inspect and document tiers"
```

---

## Self-review notes

- **Spec P1 coverage:**
  - `tier` config: Task 1
  - `minimumTierFor` / `escalatedTier`: Task 2
  - router floor, cheapest-first, and `below-minimum-tier`: Task 3
  - admission consistency: Task 3
  - escalation within `maxAttempts`: Task 2 (never creates attempts) and Task 4 (reads the persisted count)
  - `task.routing.decided` event: Task 4
  - inspect: Task 5
  - unit and escalation tests: Tasks 2–4
- **Prior-attempt count:** "prior attempts" means all persisted attempts for the task. A task is only re-run after a non-successful attempt, so the count equals the failed prior attempts. Admission (the coordinator) and routing (`routeTaskAttempt`) use the same count.
