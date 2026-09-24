/**
 * Application-level orchestrator facade that selects the executing agent
 * deterministically and runs the task's resolved workflow through the
 * workflow task executor.
 *
 * Routing order per task:
 * 1. read the task and resolve its `workflow` definition
 * 2. join configured agent profiles with discovered adapter availability
 * 3. select a profile with the pure core router
 * 4. resolve the selected adapter and hand it, the task, and the resolved
 *    workflow to a fresh `WorkflowTaskExecutor`
 *
 * When the task is missing, its workflow id is unknown, or no profile can
 * route it, the facade returns a runner-controlled rejected outcome with
 * diagnostics and never invokes the executor, so no attempt is created and no
 * agent process starts.
 */

import type { AgentRegistry, AgentRuntime } from "@agentic-dev-runner/agents";
import type { AgentProfile, Task, TaskId, WorkflowDefinition } from "@agentic-dev-runner/core";
import { resolveWorkflow } from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "@agentic-dev-runner/orchestrator";
import type {
  WorkflowTaskExecutor,
  WorkflowTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";
import { resolveRoutedAgent } from "./agent-routing.js";

export interface RoutedTaskOrchestrator {
  run(taskId: TaskId): Promise<WorkflowTaskRunOutcome>;
}

export type RoutedTaskOrchestratorOptions = {
  readonly store: RunnerStore;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agents: AgentRegistry;
  readonly adapters: AgentAdapterRegistry;
  readonly createWorkflowExecutor: (input: {
    readonly agent: AgentRuntime;
    readonly task: Task;
    readonly workflow: WorkflowDefinition;
  }) => WorkflowTaskExecutor;
};

export function createRoutedTaskOrchestrator(
  options: RoutedTaskOrchestratorOptions,
): RoutedTaskOrchestrator {
  return new RoutedTaskOrchestratorImpl(options);
}

type CreateWorkflowExecutor =
  RoutedTaskOrchestratorOptions["createWorkflowExecutor"];

class RoutedTaskOrchestratorImpl implements RoutedTaskOrchestrator {
  private readonly store: RunnerStore;
  private readonly agentProfiles: readonly AgentProfile[];
  private readonly agents: AgentRegistry;
  private readonly adapters: AgentAdapterRegistry;
  private readonly createWorkflowExecutor: CreateWorkflowExecutor;
  private running = false;

  constructor(options: RoutedTaskOrchestratorOptions) {
    this.store = options.store;
    this.agentProfiles = [...options.agentProfiles];
    this.agents = options.agents;
    this.adapters = options.adapters;
    this.createWorkflowExecutor = options.createWorkflowExecutor;
  }

  async run(taskId: TaskId): Promise<WorkflowTaskRunOutcome> {
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

  private async routeAndRun(taskId: TaskId): Promise<WorkflowTaskRunOutcome> {
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return { kind: "rejected", taskId, reason: `task "${taskId}" not found` };
    }
    const resolution = resolveWorkflow(task.workflow);
    if (!resolution.resolved) {
      return {
        kind: "rejected",
        taskId,
        reason: `unknown workflow "${task.workflow}" for task "${taskId}"`,
        taskStatus: task.status,
      };
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
    return await this.createWorkflowExecutor({
      agent: selection.runtime,
      task,
      workflow: resolution.workflow,
    }).run();
  }
}
