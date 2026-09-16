/**
 * Application-level orchestrator facade that selects the executing agent
 * deterministically before delegating to the provider-independent single-task
 * orchestrator.
 *
 * Routing order per task:
 * 1. read the task and its `routing.capabilities`
 * 2. join configured agent profiles with discovered adapter availability
 * 3. select a profile with the pure core router
 * 4. resolve the selected adapter and hand it to a fresh single-task
 *    orchestrator through the existing `AgentRuntime` injection
 *
 * When no profile can route the task, the facade returns a runner-controlled
 * rejected outcome with routing diagnostics and never invokes the orchestrator,
 * so no attempt is created and no agent process starts.
 */

import type {
  AgentDescriptor,
  AgentExecutionResult,
  AgentRegistry,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import type { AgentProfile } from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "@agentic-dev-runner/orchestrator";
import type {
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import { resolveRoutedAgent } from "./agent-routing.js";

export type RoutedTaskOrchestratorOptions = {
  readonly store: RunnerStore;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agents: AgentRegistry;
  readonly adapters: AgentAdapterRegistry;
  readonly createAgentBackedOrchestrator: (
    agent: AgentRuntime,
  ) => SingleTaskOrchestrator;
};

export function createRoutedTaskOrchestrator(
  options: RoutedTaskOrchestratorOptions,
): SingleTaskOrchestrator {
  return new RoutedTaskOrchestrator(options);
}

class RoutedTaskOrchestrator implements SingleTaskOrchestrator {
  private readonly store: RunnerStore;
  private readonly agentProfiles: readonly AgentProfile[];
  private readonly agents: AgentRegistry;
  private readonly adapters: AgentAdapterRegistry;
  private readonly createAgentBackedOrchestrator: (
    agent: AgentRuntime,
  ) => SingleTaskOrchestrator;
  private running = false;

  constructor(options: RoutedTaskOrchestratorOptions) {
    this.store = options.store;
    this.agentProfiles = [...options.agentProfiles];
    this.agents = options.agents;
    this.adapters = options.adapters;
    this.createAgentBackedOrchestrator = options.createAgentBackedOrchestrator;
  }

  async run(taskId: string): Promise<SingleTaskRunOutcome> {
    if (this.running) {
      throw new OrchestrationError(
        "A task is already executing in this orchestrator; single-task orchestration is strictly sequential",
      );
    }
    this.running = true;
    try {
      return await this.routeAndRun(taskId);
    } finally {
      this.running = false;
    }
  }

  private async routeAndRun(taskId: string): Promise<SingleTaskRunOutcome> {
    const task = await this.store.getTask(taskId);
    if (task === null) {
      // Routing requirements are unknown for a missing task; delegate so the
      // orchestrator reports it. The unrouted runtime is never invoked because
      // the orchestrator rejects before any agent invocation.
      return await this.agentBacked(unroutedAgentRuntime()).run(taskId);
    }
    const selection = await resolveRoutedAgent({
      requiredCapabilities: task.routing.capabilities,
      agentProfiles: this.agentProfiles,
      agents: this.agents,
      adapters: this.adapters,
    });
    if (!selection.routed) {
      return {
        kind: "rejected",
        taskId,
        reason: `no agent profile can route task "${taskId}": ${selection.reason}`,
        taskStatus: task.status,
      };
    }
    return await this.agentBacked(selection.runtime).run(taskId);
  }

  private agentBacked(agent: AgentRuntime): SingleTaskOrchestrator {
    return this.createAgentBackedOrchestrator(agent);
  }
}

/**
 * Placeholder runtime for paths that never reach an agent invocation
 * (a missing task). Invoking it is a wiring violation, not a fallback.
 */
class UnroutedAgentRuntime implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "unrouted" };

  async invoke(): Promise<AgentExecutionResult> {
    throw new Error(
      "no agent runtime was selected; routing must select an agent before the orchestrator can invoke it",
    );
  }
}

function unroutedAgentRuntime(): AgentRuntime {
  return new UnroutedAgentRuntime();
}
