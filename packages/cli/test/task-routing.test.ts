import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "@agentic-dev-runner/core";
import type { AgentAvailability, AgentRegistry, AgentRuntime } from "@agentic-dev-runner/agents";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { routeTaskAttempt } from "../src/application/agents/task-routing.js";
import { createFixtureAttempt, createFixtureProject, createFixtureTask } from "./fixtures.js";

class StubRuntime implements AgentRuntime {
  constructor(readonly descriptor: AgentRuntime["descriptor"]) {}
  async invoke(): Promise<never> {
    throw new Error("routing tests never invoke agents");
  }
}

describe("routeTaskAttempt", () => {
  let store: RunnerStore | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  it("uses the persisted attempt count and appends one route decision", async () => {
    store = createSqliteRunnerStore({ path: ":memory:" });
    await store.initialize();
    const task = createFixtureTask();
    await store.putProject(createFixtureProject());
    await store.putTask(task);
    await store.putAttempt(createFixtureAttempt({ status: "FAILED" }));
    const profiles: AgentProfile[] = [
      { id: "cheap", adapterId: "cheap-adapter", tier: "economy", capabilities: ["typescript"] },
      { id: "standard", adapterId: "standard-adapter", tier: "standard", capabilities: ["typescript"] },
    ];
    const agents: AgentAvailability[] = [
      { id: "cheap-adapter", available: true, version: null, reason: null },
      { id: "standard-adapter", available: true, version: null, reason: null },
    ];
    const registry: AgentRegistry = {
      agentIds: agents.map(({ id }) => id),
      discoverAgents: async () => agents,
    };
    const result = await routeTaskAttempt({
      task,
      store,
      agentProfiles: profiles,
      agents: registry,
      adapters: createAgentAdapterRegistry([
        new StubRuntime({ id: "cheap-adapter" }),
        new StubRuntime({ id: "standard-adapter" }),
      ]),
    });

    expect(result.routed && result.profile.id).toBe("standard");
    const events = await store.listEvents({ taskId: task.id, type: "task.routing.decided" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      profileId: "standard",
      selectedTier: "standard",
      minimumTier: "standard",
      attemptCount: 1,
      failedAttemptCount: 1,
    });
    expect((events[0]?.payload as { reason: string }).reason).toContain("after 1 failed attempt");
  });

  it("does not escalate after a cancelled attempt and explains the risk floor", async () => {
    store = createSqliteRunnerStore({ path: ":memory:" });
    await store.initialize();
    const task = createFixtureTask();
    await store.putProject(createFixtureProject());
    await store.putTask(task);
    await store.putAttempt(createFixtureAttempt({ status: "CANCELLED" }));
    const profiles: AgentProfile[] = [
      { id: "cheap", adapterId: "cheap-adapter", tier: "economy", capabilities: ["typescript"] },
    ];
    const registry: AgentRegistry = {
      agentIds: ["cheap-adapter"],
      discoverAgents: async () => [{ id: "cheap-adapter", available: true, version: null, reason: null }],
    };
    const result = await routeTaskAttempt({
      task,
      store,
      agentProfiles: profiles,
      agents: registry,
      adapters: createAgentAdapterRegistry([new StubRuntime({ id: "cheap-adapter" })]),
    });

    expect(result.routed).toBe(true);
    const events = await store.listEvents({ taskId: task.id, type: "task.routing.decided" });
    expect(events[0]?.payload).toMatchObject({
      profileId: "cheap",
      minimumTier: "economy",
      attemptCount: 1,
      failedAttemptCount: 0,
      reason: "risk low and complexity small require minimum tier economy",
    });
  });

  it("reports and records a below-minimum-tier rejection", async () => {
    store = createSqliteRunnerStore({ path: ":memory:" });
    await store.initialize();
    const task = { ...createFixtureTask(), risk: "high" as const };
    await store.putProject(createFixtureProject());
    await store.putTask(task);
    const profiles: AgentProfile[] = [
      { id: "cheap", adapterId: "cheap-adapter", tier: "economy", capabilities: ["typescript"] },
    ];
    const registry: AgentRegistry = {
      agentIds: ["cheap-adapter"],
      discoverAgents: async () => [{ id: "cheap-adapter", available: true, version: null, reason: null }],
    };
    const result = await routeTaskAttempt({
      task,
      store,
      agentProfiles: profiles,
      agents: registry,
      adapters: createAgentAdapterRegistry([new StubRuntime({ id: "cheap-adapter" })]),
    });

    expect(result.routed).toBe(false);
    if (!result.routed) expect(result.reason).toContain('tier "economy" below required minimum "strong"');
    const events = await store.listEvents({ taskId: task.id, type: "task.routing.decided" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ profileId: null, minimumTier: "strong" });
  });
});
