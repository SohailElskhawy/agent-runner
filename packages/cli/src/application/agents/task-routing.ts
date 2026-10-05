import {
  profileTier,
  requiredTierFor,
  type AgentProfile,
  type Task,
} from "@agentic-dev-runner/core";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import { resolveRoutedAgent, type RoutedAgentSelection } from "./agent-routing.js";

export type RouteTaskAttemptInput = {
  readonly task: Task;
  readonly store: RunnerStore;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agents: AgentRegistry;
  readonly adapters: AgentAdapterRegistry;
};

export async function routeTaskAttempt(
  input: RouteTaskAttemptInput,
): Promise<RoutedAgentSelection> {
  const attempts = await input.store.listAttempts({ taskId: input.task.id });
  const attemptCount = attempts.length;
  const failedAttemptCount = attempts.filter(
    ({ status }) => status === "FAILED" || status === "TIMED_OUT",
  ).length;
  const baseTier = requiredTierFor(input.task, 0);
  const minimumTier = requiredTierFor(input.task, failedAttemptCount);
  const selection = await resolveRoutedAgent({
    requiredCapabilities: input.task.routing.capabilities,
    agentProfiles: input.agentProfiles,
    agents: input.agents,
    adapters: input.adapters,
    minimumTier,
  });
  await input.store.appendEvents([
    {
      type: "task.routing.decided",
      taskId: input.task.id,
      occurredAt: new Date().toISOString(),
      payload: {
        profileId: selection.routed ? selection.profile.id : null,
        selectedTier: selection.routed ? profileTier(selection.profile) : null,
        minimumTier,
        attemptCount,
        failedAttemptCount,
        reason: routeReason(input.task, baseTier, minimumTier, failedAttemptCount, selection),
      },
    },
  ]);
  return selection;
}

function routeReason(
  task: Task,
  baseTier: ReturnType<typeof requiredTierFor>,
  minimumTier: ReturnType<typeof requiredTierFor>,
  failedAttemptCount: number,
  selection: RoutedAgentSelection,
): string {
  const floorReason =
    minimumTier !== baseTier
      ? `minimum tier raised from ${baseTier} to ${minimumTier} after ${String(failedAttemptCount)} failed attempt${failedAttemptCount === 1 ? "" : "s"} (risk ${task.risk}, complexity ${task.routing.complexity})`
      : `risk ${task.risk} and complexity ${task.routing.complexity} require minimum tier ${minimumTier}`;
  return selection.routed ? floorReason : `${selection.reason}; ${floorReason}`;
}
