import { describe, expect, it } from "vitest";
import type {
  Attempt,
  ExecutionClaim,
  Project,
  ResourceLock,
  StageRun,
  Task,
  WorkflowDefinition,
} from "@agentic-dev-runner/core";
import type {
  StoredEvent,
  NewEvent,
  RunnerStore,
  TaskExecutionClaimRequest,
  TaskExecutionClaimResult,
} from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "@agentic-dev-runner/orchestrator";
import type {
  WorkflowTaskExecutor,
  WorkflowTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type {
  AgentDescriptor,
  AgentExecutionResult,
  AgentRegistry,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import type { AgentProfile } from "@agentic-dev-runner/core";
import {
  createRoutedTaskOrchestrator,
  type RoutedTaskOrchestrator,
} from "../src/application/agents/routed-task-orchestrator.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { createFixtureTask } from "./fixtures.js";

class StubAgentRuntime implements AgentRuntime {
  constructor(readonly descriptor: AgentDescriptor) {}

  async invoke(): Promise<AgentExecutionResult> {
    throw new Error("stub agent runtime must not be invoked in routing tests");
  }
}

class RecordingStore implements RunnerStore {
  readonly tasks = new Map<string, Task>();
  readonly attempts: Attempt[] = [];
  readonly events: NewEvent[] = [];

  async initialize(): Promise<void> {}
  async getProject(): Promise<Project | null> {
    return null;
  }
  async listProjects(): Promise<Project[]> {
    return [];
  }
  async putProject(): Promise<void> {}
  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null;
  }
  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()];
  }
  async putTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }
  async getAttempt(): Promise<Attempt | null> {
    return null;
  }
  async listAttempts(): Promise<Attempt[]> {
    return this.attempts;
  }
  async putAttempt(attempt: Attempt): Promise<void> {
    this.attempts.push(attempt);
  }
  async listExecutionClaims(): Promise<ExecutionClaim[]> {
    return [];
  }
  async claimTaskExecution(
    request: TaskExecutionClaimRequest,
  ): Promise<TaskExecutionClaimResult> {
    return { kind: "task-not-ready", taskId: request.taskId };
  }
  async releaseTaskExecution(): Promise<boolean> {
    return true;
  }
  async releaseRecoveredTaskExecution(): Promise<boolean> {
    return false;
  }
  async renewTaskExecution(): Promise<boolean> {
    return false;
  }
  async claimExpiredExecutionRecovery(): Promise<boolean> {
    return false;
  }
  async getTaskStatus(): Promise<Task["status"] | null> {
    return null;
  }
  async setTaskStatus(): Promise<void> {}
  async transitionTaskStatusFrom(): Promise<boolean> {
    return false;
  }
  async approveTask(): Promise<boolean> {
    return false;
  }
  async putStageRun(): Promise<void> {}
  async listStageRuns(): Promise<StageRun[]> {
    return [];
  }
  async listResourceLocks(): Promise<ResourceLock[]> {
    return [];
  }
  async acquireResourceLocks(): Promise<void> {}
  async releaseResourceLocks(): Promise<void> {}
  async listIntegrationQueueEntries(): Promise<never[]> {
    return [];
  }
  async enqueueIntegrationQueueEntry(): Promise<never> {
    throw new Error("integration queue must not be used in routing tests");
  }
  async claimNextIntegrationQueueEntry(): Promise<null> {
    return null;
  }
  async completeIntegrationQueueEntry(): Promise<void> {}
  async failIntegrationQueueEntry(): Promise<void> {}
  async requeueIntegrationQueueEntry(): Promise<void> {}
  async appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> {
    this.events.push(...events);
    return [];
  }
  async listEvents(): Promise<StoredEvent[]> {
    return [];
  }
  async transaction<T>(body: () => Promise<T>): Promise<T> {
    return await body();
  }
  async close(): Promise<void> {}
}

const codexProfile: AgentProfile = {
  id: "codex-profile",
  adapterId: "codex",
  model: "gpt-5-codex",
  capabilities: ["typescript", "debugging"],
};

const opencodeProfile: AgentProfile = {
  id: "opencode-profile",
  adapterId: "opencode",
  capabilities: ["typescript", "javascript"],
};

const rejectedOutcome: WorkflowTaskRunOutcome = {
  kind: "rejected",
  taskId: "M001",
  reason: "task is not runnable",
};

function registryWith(
  records: readonly { id: string; available: boolean }[],
): AgentRegistry {
  return {
    agentIds: records.map((record) => record.id),
    discoverAgents: async () =>
      records.map((record) => ({ ...record, version: null, reason: null })),
  };
}

describe("createRoutedTaskOrchestrator", () => {
  type ExecutorCall = {
    readonly agent: AgentRuntime;
    readonly task: Task;
    readonly workflow: WorkflowDefinition;
  };

  function routedOrchestrator(input: {
    profiles: readonly AgentProfile[];
    availability: readonly { id: string; available: boolean }[];
    adapters?: readonly AgentRuntime[];
    store: RunnerStore;
    outcome?: WorkflowTaskRunOutcome;
  }): {
    orchestrator: RoutedTaskOrchestrator;
    executorCalls: ExecutorCall[];
  } {
    const executorCalls: ExecutorCall[] = [];
    const orchestrator = createRoutedTaskOrchestrator({
      store: input.store,
      agentProfiles: input.profiles,
      agents: registryWith(input.availability),
      adapters: createAgentAdapterRegistry(
        input.adapters ?? [
          new StubAgentRuntime({ id: "opencode" }),
          new StubAgentRuntime({ id: "codex" }),
        ],
      ),
      createWorkflowExecutor: (call) => {
        executorCalls.push(call);
        const executor: WorkflowTaskExecutor = {
          async run(): Promise<WorkflowTaskRunOutcome> {
            return input.outcome ?? rejectedOutcome;
          },
        };
        return executor;
      },
    });
    return { orchestrator, executorCalls };
  }

  function seededStore(
    capabilities: readonly string[],
    workflow = "default",
  ): RecordingStore {
    const store = new RecordingStore();
    const task = createFixtureTask();
    store.putTask({
      ...task,
      workflow,
      routing: { complexity: task.routing.complexity, capabilities },
    });
    return store;
  }

  it("delegates to the workflow executor with the selected agent and resolved workflow", async () => {
    const completedOutcome: WorkflowTaskRunOutcome = {
      kind: "completed",
      taskId: "M001",
      attemptId: "att_M001_1",
      task: createFixtureTask(),
      attempt: {
        id: "att_M001_1",
        taskId: "M001",
        number: 1,
        status: "SUCCEEDED",
        agent: "codex",
        baseRevision: "base",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
      },
      branch: "task/M001/attempt-1",
      worktreePath: "fixture/worktrees/M001/attempt-1",
      integration: { kind: "fast-forward", revision: "abc1234" },
    };
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [codexProfile, opencodeProfile],
      availability: [
        { id: "codex", available: true },
        { id: "opencode", available: true },
      ],
      store: seededStore(["typescript"]),
      outcome: completedOutcome,
    });

    const outcome = await orchestrator.run("M001");

    expect(outcome).toBe(completedOutcome);
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]?.agent.descriptor).toEqual({
      id: "codex",
      model: "gpt-5-codex",
    });
    expect(executorCalls[0]?.task.id).toBe("M001");
    expect(executorCalls[0]?.workflow.id).toBe("default");
  });

  it("selects the first eligible configured profile deterministically", async () => {
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [codexProfile, opencodeProfile],
      availability: [
        { id: "codex", available: true },
        { id: "opencode", available: true },
      ],
      store: seededStore(["typescript"]),
    });

    await orchestrator.run("M001");

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]?.agent.descriptor.id).toBe("codex");
  });

  it("returns a runner-controlled rejected outcome with routing diagnostics when no profile can route", async () => {
    const store = seededStore(["rust"]);
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [opencodeProfile, codexProfile],
      availability: [
        { id: "opencode", available: true },
        { id: "codex", available: true },
      ],
      adapters: [new StubAgentRuntime({ id: "opencode" })],
      store,
    });

    const outcome = await orchestrator.run("M001");

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe(
      'no agent profile can route task "M001": no eligible agent profile: profile "opencode-profile" is missing required capabilities: rust; profile "codex-profile" is missing required capabilities: rust',
    );
    expect(outcome.taskStatus).toBe("READY");
    expect(executorCalls).toHaveLength(0);
    expect(store.attempts).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });

  it("never invokes the selected agent runtime when routing fails", async () => {
    const store = seededStore(["rust"]);
    const recordingRuntime: AgentRuntime = {
      descriptor: { id: "opencode" },
      invoke: async () => {
        throw new Error("agent must not start when routing fails");
      },
    };
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [opencodeProfile],
      availability: [{ id: "opencode", available: true }],
      adapters: [recordingRuntime],
      store,
    });

    const outcome = await orchestrator.run("M001");

    expect(outcome.kind).toBe("rejected");
    expect(executorCalls).toHaveLength(0);
    expect(store.attempts).toHaveLength(0);
  });

  it("rejects clearly when no agent profiles are configured", async () => {
    const store = seededStore(["typescript"]);
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [],
      availability: [{ id: "opencode", available: true }],
      store,
    });

    const outcome = await orchestrator.run("M001");

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toContain("no agent profiles are configured");
    expect(executorCalls).toHaveLength(0);
    expect(store.attempts).toHaveLength(0);
  });

  it("treats profiles referencing unknown adapters as unavailable without crashing or falling back", async () => {
    const store = seededStore(["typescript"]);
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [
        { id: "unknown-profile", adapterId: "claude", capabilities: ["typescript"] },
      ],
      availability: [{ id: "codex", available: true }],
      store,
    });

    const outcome = await orchestrator.run("M001");

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toContain(
      'references unknown adapter "claude" with no discovery result',
    );
    expect(executorCalls).toHaveLength(0);
  });

  it("routes to the next available eligible profile when the first is unavailable", async () => {
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [opencodeProfile, codexProfile],
      availability: [
        { id: "opencode", available: false },
        { id: "codex", available: true },
      ],
      adapters: [new StubAgentRuntime({ id: "codex" })],
      store: seededStore(["typescript"]),
    });

    await orchestrator.run("M001");

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]?.agent.descriptor.id).toBe("codex");
  });

  it("rejects a missing task without invoking the executor", async () => {
    const store = new RecordingStore();
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [codexProfile],
      availability: [{ id: "codex", available: true }],
      store,
    });

    const outcome = await orchestrator.run("M999");

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe('task "M999" not found');
    expect(executorCalls).toHaveLength(0);
    expect(store.attempts).toHaveLength(0);
  });

  it("rejects an unknown workflow id without invoking the executor", async () => {
    const store = seededStore(["typescript"], "custom-unknown");
    const { orchestrator, executorCalls } = routedOrchestrator({
      profiles: [codexProfile],
      availability: [{ id: "codex", available: true }],
      store,
    });

    const outcome = await orchestrator.run("M001");

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe(
      'unknown workflow "custom-unknown" for task "M001"',
    );
    expect(outcome.taskStatus).toBe("READY");
    expect(executorCalls).toHaveLength(0);
    expect(store.attempts).toHaveLength(0);
  });

  it("rejects a second run while one is still executing", async () => {
    const store = seededStore(["typescript"]);
    let release!: (outcome: WorkflowTaskRunOutcome) => void;
    const gate = new Promise<WorkflowTaskRunOutcome>((resolve) => {
      release = resolve;
    });
    const orchestrator = createRoutedTaskOrchestrator({
      store,
      agentProfiles: [codexProfile],
      agents: registryWith([{ id: "codex", available: true }]),
      adapters: createAgentAdapterRegistry([new StubAgentRuntime({ id: "codex" })]),
      createWorkflowExecutor: () => ({
        async run(): Promise<WorkflowTaskRunOutcome> {
          return await gate;
        },
      }),
    });

    const first = orchestrator.run("M001");
    const second = orchestrator.run("M001");

    await expect(second).rejects.toThrow(OrchestrationError);
    await expect(second).rejects.toThrow("strictly sequential");
    release(rejectedOutcome);
    await expect(first).resolves.toBe(rejectedOutcome);
  });

  it("propagates discovery failures instead of silently falling back", async () => {
    const failingRegistry: AgentRegistry = {
      agentIds: ["codex"],
      discoverAgents: async () => {
        throw new Error("discovery exploded");
      },
    };
    const executorCalls: ExecutorCall[] = [];
    const orchestrator = createRoutedTaskOrchestrator({
      store: seededStore(["typescript"]),
      agentProfiles: [codexProfile],
      agents: failingRegistry,
      adapters: createAgentAdapterRegistry([new StubAgentRuntime({ id: "codex" })]),
      createWorkflowExecutor: (call) => {
        executorCalls.push(call);
        return {
          async run(): Promise<WorkflowTaskRunOutcome> {
            return rejectedOutcome;
          },
        };
      },
    });

    await expect(orchestrator.run("M001")).rejects.toThrow("discovery exploded");
    expect(executorCalls).toHaveLength(0);
  });
});
