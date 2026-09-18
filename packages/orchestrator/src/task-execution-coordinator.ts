import type {
  AgentRouteCandidate,
  IsoTimestamp,
  Task,
  TaskId,
} from "@agentic-dev-runner/core";
import {
  countParallelismActiveExecutions,
  detectTaskConflicts,
  evaluateParallelismCapacity,
  orderRunnableTasks,
  requiredResourceLocks,
  selectRunnableTasks,
  isParallelismActiveStatus,
} from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { WorkflowTaskExecutor } from "./workflow-executor.js";
import type { WorkflowTaskRunOutcome } from "./workflow-outcome.js";

export type TaskExecutionCoordinatorOptions = {
  readonly store: RunnerStore;
  readonly agentCandidates: readonly AgentRouteCandidate[];
  readonly maxParallelism: number;
  readonly projectId?: string | undefined;
  /** Creates the already-wired workflow executor for one admitted task. */
  readonly createExecutor: (
    task: Task,
  ) => WorkflowTaskExecutor | Promise<WorkflowTaskExecutor>;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export type TaskAdmission = {
  readonly taskId: TaskId;
  readonly kind: "admitted" | "deferred";
  readonly reason?:
    | "capacity-exhausted"
    | "conflict"
    | "lock-unavailable"
    | undefined;
};

export type TaskExecutionResult = {
  readonly taskId: TaskId;
  readonly outcome: WorkflowTaskRunOutcome | undefined;
  readonly error?: string | undefined;
};

export type TaskDispatchResult = {
  readonly admissions: readonly TaskAdmission[];
  readonly executions: readonly TaskExecutionResult[];
  readonly activeExecutions: number;
};

export interface TaskExecutionCoordinator {
  /**
   * Re-reads durable state, admits every currently eligible task that fits,
   * starts admitted workflows concurrently, and waits for that batch to
   * settle. Individual workflow failures are returned as results and never
   * reject the batch.
   */
  dispatchAvailable(): Promise<TaskDispatchResult>;
}

export function createTaskExecutionCoordinator(
  options: TaskExecutionCoordinatorOptions,
): TaskExecutionCoordinator {
  return new DurableTaskExecutionCoordinator(options);
}

class DurableTaskExecutionCoordinator implements TaskExecutionCoordinator {
  private readonly store: RunnerStore;
  private readonly agentCandidates: readonly AgentRouteCandidate[];
  private readonly maxParallelism: number;
  private readonly projectId: string | undefined;
  private readonly createExecutor: TaskExecutionCoordinatorOptions["createExecutor"];
  private readonly clock: () => IsoTimestamp;
  private readonly activeTaskIds = new Set<TaskId>();

  constructor(options: TaskExecutionCoordinatorOptions) {
    if (options.maxParallelism <= 0 || !Number.isInteger(options.maxParallelism)) {
      throw new Error("maxParallelism must be a positive integer");
    }
    this.store = options.store;
    this.agentCandidates = [...options.agentCandidates];
    this.maxParallelism = options.maxParallelism;
    this.projectId = options.projectId;
    this.createExecutor = options.createExecutor;
    this.clock = options.now ?? defaultClock;
  }

  async dispatchAvailable(): Promise<TaskDispatchResult> {
    const tasks = await this.store.listTasks(
      this.projectId === undefined ? undefined : { projectId: this.projectId },
    );
    const attempts = await Promise.all(
      tasks.map(async (task) => [
        task.id,
        (await this.store.listAttempts({ taskId: task.id })).length,
      ] as const),
    );
    const selection = selectRunnableTasks({
      tasks,
      attemptCounts: new Map(attempts),
      agentCandidates: this.agentCandidates,
    });
    const ordered = orderRunnableTasks(selection.runnable);
    const activePersisted = tasks.filter((task) =>
      isParallelismActiveStatus(task.status),
    );
    const admissions: TaskAdmission[] = [];
    const admittedTasks: Task[] = [];
    const executions: Promise<TaskExecutionResult>[] = [];
    let activeExecutions = countParallelismActiveExecutions(
      tasks.map((task) => task.status),
    );

    for (const task of ordered) {
      if (this.activeTaskIds.has(task.id)) {
        admissions.push({ taskId: task.id, kind: "deferred", reason: "conflict" });
        continue;
      }
      const capacity = evaluateParallelismCapacity({
        maxParallelism: this.maxParallelism,
        activeExecutions,
      });
      if (capacity.status === "exhausted") {
        admissions.push({
          taskId: task.id,
          kind: "deferred",
          reason: "capacity-exhausted",
        });
        break;
      }

      const conflicts = detectTaskConflicts([
        ...activePersisted,
        ...admittedTasks,
        task,
      ]).filter(
        (conflict) =>
          conflict.taskIdA === task.id || conflict.taskIdB === task.id,
      );
      if (conflicts.length > 0) {
        admissions.push({ taskId: task.id, kind: "deferred", reason: "conflict" });
        continue;
      }

      const locks = requiredResourceLocks(
        { taskId: task.id },
        task.definition.resources,
      ).map((lock) => ({ ...lock, acquiredAt: this.clock() }));
      try {
        await this.store.acquireResourceLocks(locks);
      } catch {
        // The store acquisition is the race-safe gate. A contender losing the
        // race is deferred, while later independent candidates are still
        // considered in this same deterministic pass.
        admissions.push({
          taskId: task.id,
          kind: "deferred",
          reason: "lock-unavailable",
        });
        continue;
      }

      admissions.push({ taskId: task.id, kind: "admitted" });
      admittedTasks.push(task);
      activeExecutions += 1;
      this.activeTaskIds.add(task.id);
      executions.push(this.executeAdmitted(task));
    }

    const settled = await Promise.all(executions);
    return {
      admissions,
      executions: settled,
      activeExecutions,
    };
  }

  private async executeAdmitted(task: Task): Promise<TaskExecutionResult> {
    try {
      const executor = await this.createExecutor(task);
      const outcome = await executor.run();
      await this.releaseIfTerminal(task.id);
      return { taskId: task.id, outcome };
    } catch (error) {
      await this.releaseIfTerminal(task.id);
      return {
        taskId: task.id,
        outcome: undefined,
        error: describeError(error),
      };
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }

  private async releaseIfTerminal(taskId: TaskId): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (task === null || isParallelismActiveStatus(task.status)) {
      return;
    }
    await this.store.releaseResourceLocks({ taskId });
  }
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
