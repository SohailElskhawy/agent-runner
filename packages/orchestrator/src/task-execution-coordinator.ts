import { randomUUID } from "node:crypto";
import type {
  AgentRouteCandidate,
  ExecutionClaim,
  IsoTimestamp,
  Task,
  TaskId,
} from "@agentic-dev-runner/core";
import {
  countParallelismActiveExecutions,
  detectTaskConflicts,
  evaluateParallelismCapacity,
  isParallelismActiveStatus,
  orderRunnableTasks,
  selectRunnableTasks,
} from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import {
  ORCHESTRATION_EVENTS,
  type TaskTransitionedPayload,
} from "./orchestration-events.js";
import type { WorkflowTaskExecutor } from "./workflow-executor.js";
import type { WorkflowTaskRunOutcome } from "./workflow-outcome.js";

export type TaskExecutionCoordinatorOptions = {
  readonly store: RunnerStore;
  readonly agentCandidates:
    | readonly AgentRouteCandidate[]
    | (() => Promise<readonly AgentRouteCandidate[]>);
  readonly maxParallelism: number;
  /** Bounded durable liveness window for a scheduler execution. */
  readonly leaseDurationMs?: number | undefined;
  readonly projectId?: string | undefined;
  readonly createExecutor: (
    task: Task,
    executionId: string,
  ) => WorkflowTaskExecutor | Promise<WorkflowTaskExecutor>;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export type TaskAdmission = {
  readonly taskId: TaskId;
  readonly kind: "admitted" | "deferred";
  readonly reason?:
    | "capacity-exhausted"
    | "conflict"
    | "already-claimed"
    | "lock-unavailable"
    | undefined;
};

export type TaskExecutionResult = {
  readonly taskId: TaskId;
  readonly outcome: WorkflowTaskRunOutcome | undefined;
  readonly error?: string | undefined;
  readonly recoveryRequired?: boolean | undefined;
};

export type TaskDispatchResult = {
  readonly admissions: readonly TaskAdmission[];
  readonly executions: readonly TaskExecutionResult[];
  readonly activeExecutions: number;
  readonly activeClaims: readonly ExecutionClaim[];
};

export interface TaskExecutionCoordinator {
  dispatchAvailable(): Promise<TaskDispatchResult>;
}

export function createTaskExecutionCoordinator(
  options: TaskExecutionCoordinatorOptions,
): TaskExecutionCoordinator {
  return new DurableTaskExecutionCoordinator(options);
}

class DurableTaskExecutionCoordinator implements TaskExecutionCoordinator {
  private readonly store: RunnerStore;
  private readonly candidates: TaskExecutionCoordinatorOptions["agentCandidates"];
  private readonly maxParallelism: number;
  private readonly projectId: string | undefined;
  private readonly createExecutor: TaskExecutionCoordinatorOptions["createExecutor"];
  private readonly clock: () => IsoTimestamp;
  private readonly leaseDurationMs: number;
  private readonly activeTaskIds = new Set<TaskId>();

  constructor(options: TaskExecutionCoordinatorOptions) {
    if (options.maxParallelism <= 0 || !Number.isInteger(options.maxParallelism)) {
      throw new Error("maxParallelism must be a positive integer");
    }
    this.store = options.store;
    this.candidates = options.agentCandidates;
    this.maxParallelism = options.maxParallelism;
    this.projectId = options.projectId;
    this.createExecutor = options.createExecutor;
    this.clock = options.now ?? defaultClock;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error("leaseDurationMs must be a positive integer");
    }
  }

  async dispatchAvailable(): Promise<TaskDispatchResult> {
    const tasks = await this.store.listTasks(
      this.projectId === undefined ? undefined : { projectId: this.projectId },
    );
    const activeClaims = await this.store.listExecutionClaims({ status: "ACTIVE" });
    const claimedTaskIds = new Set(activeClaims.map((claim) => claim.taskId));
    const selectableTasks = tasks.filter((task) => !claimedTaskIds.has(task.id));
    const attempts = await Promise.all(
      selectableTasks.map(async (task) => [
        task.id,
        (await this.store.listAttempts({ taskId: task.id })).length,
      ] as const),
    );
    const agentCandidates =
      typeof this.candidates === "function"
        ? await this.candidates()
        : this.candidates;
    const selection = selectRunnableTasks({
      tasks: selectableTasks,
      attemptCounts: new Map(attempts),
      agentCandidates,
    });
    const ordered = orderRunnableTasks(selection.runnable);
    const activePersisted = tasks.filter((task) =>
      isParallelismActiveStatus(task.status),
    );
    const admissions: TaskAdmission[] = [];
    const admittedTasks: Task[] = [];
    const executions: Promise<TaskExecutionResult>[] = [];
    let activeExecutions = Math.max(
      activeClaims.length,
      countParallelismActiveExecutions(tasks.map((task) => task.status)),
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

      const executionId = `exec_${randomUUID()}`;
      const claim = await this.store.claimTaskExecution({
        taskId: task.id,
        executionId,
        maxParallelism: this.maxParallelism,
        resources: task.definition.resources,
        claimedAt: this.clock(),
        leaseExpiresAt: addLease(this.clock(), this.leaseDurationMs),
      });
      if (claim.kind !== "claimed") {
        const reason =
          claim.kind === "capacity-exhausted"
            ? "capacity-exhausted"
            : claim.kind === "already-claimed"
              ? "already-claimed"
              : claim.kind === "resource-unavailable"
                ? "lock-unavailable"
                : "conflict";
        admissions.push({ taskId: task.id, kind: "deferred", reason });
        if (claim.kind === "capacity-exhausted") {
          break;
        }
        continue;
      }

      admissions.push({ taskId: task.id, kind: "admitted" });
      admittedTasks.push(task);
      activeExecutions += 1;
      this.activeTaskIds.add(task.id);
      executions.push(this.executeAdmitted(task, claim.claim));
    }

    const settled = await Promise.all(executions);
    return {
      admissions,
      executions: settled,
      activeExecutions,
      activeClaims: await this.store.listExecutionClaims({ status: "ACTIVE" }),
    };
  }

  private async executeAdmitted(
    task: Task,
    claim: ExecutionClaim,
  ): Promise<TaskExecutionResult> {
    let heartbeat: { readonly stop: () => Promise<void>; readonly assertHealthy: () => void } | undefined;
    try {
      const executor = await this.createExecutor(task, claim.id);
      heartbeat = await this.startHeartbeat(claim.id);
      const outcome = await executor.run();
      heartbeat.assertHealthy();
      await this.releaseIfTerminal(task.id, claim, outcome);
      await heartbeat.stop();
      heartbeat = undefined;
      return { taskId: task.id, outcome };
    } catch (error) {
      let effectiveError = error;
      if (heartbeat !== undefined) {
        try {
          await heartbeat.stop();
        } catch (heartbeatError) {
          effectiveError = heartbeatError;
        }
      }
      const recoveryRequired = await this.handleUnexpectedFailure(task, claim, effectiveError);
      return {
        taskId: task.id,
        outcome: undefined,
        error: describeError(effectiveError),
        recoveryRequired,
      };
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }

  private async renew(executionId: string): Promise<void> {
    const renewedAt = this.clock();
    const renewed = await this.store.renewTaskExecution(
      executionId,
      renewedAt,
      addLease(renewedAt, this.leaseDurationMs),
    );
    if (!renewed) {
      throw new Error(`execution claim "${executionId}" is no longer active`);
    }
  }

  private async startHeartbeat(executionId: string): Promise<{ readonly stop: () => Promise<void>; readonly assertHealthy: () => void }> {
    await this.renew(executionId);
    const cadenceMs = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    let stopped = false;
    let failure: unknown;
    let inFlight: Promise<void> | undefined;
    const beat = (): void => {
      if (stopped || failure !== undefined || inFlight !== undefined) return;
      inFlight = this.renew(executionId).catch((error: unknown) => {
        failure = error;
      }).finally(() => {
        inFlight = undefined;
      });
    };
    const timer = setInterval(beat, cadenceMs);
    const stop = async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (failure !== undefined) throw failure;
    };
    return {
      stop,
      assertHealthy: () => {
        if (failure !== undefined) throw failure;
      },
    };
  }

  private async releaseIfTerminal(
    taskId: TaskId,
    claim: ExecutionClaim,
    outcome: WorkflowTaskRunOutcome,
  ): Promise<void> {
    if (outcome.kind === "pending-integration") {
      return;
    }
    const task = await this.store.getTask(taskId);
    if (task === null || isParallelismActiveStatus(task.status)) {
      return;
    }
    await this.store.releaseTaskExecution(
      claim.id,
      claimStatusForTask(task.status),
      this.clock(),
    );
  }

  private async handleUnexpectedFailure(
    task: Task,
    claim: ExecutionClaim,
    error: unknown,
  ): Promise<boolean> {
    const queueEntries = await this.store.listIntegrationQueueEntries({
      executionId: claim.id,
    });
    if (queueEntries.some((entry) => entry.status === "PENDING" || entry.status === "INTEGRATING")) {
      return true;
    }
    const current = await this.store.getTask(task.id);
    const finishedAt = this.clock();
    const targetStatus =
      current !== null && isParallelismActiveStatus(current.status)
        ? "NEEDS_HUMAN"
        : "FAILED";
    try {
      await this.store.transaction(async () => {
        const attempts = await this.store.listAttempts({ taskId: task.id });
        const runningAttempt = attempts
          .filter((attempt) => attempt.status === "RUNNING")
          .at(-1);
        if (runningAttempt !== undefined) {
          await this.store.putAttempt({
            ...runningAttempt,
            status: "FAILED",
            finishedAt,
            failure: { kind: "error", message: describeError(error) },
          });
        }
        if (current !== null && current.status !== "DONE") {
          await this.store.setTaskStatus(task.id, targetStatus, finishedAt);
          await this.store.appendEvents([
            {
              type: ORCHESTRATION_EVENTS.taskTransitioned,
              taskId: task.id,
              payload: {
                from: current.status,
                to: targetStatus,
                ...(runningAttempt === undefined
                  ? {}
                  : { attemptId: runningAttempt.id }),
                failure: { kind: "error", message: describeError(error) },
              } satisfies TaskTransitionedPayload,
              occurredAt: finishedAt,
            },
          ]);
        }
      });
      await this.store.releaseTaskExecution(
        claim.id,
        targetStatus === "NEEDS_HUMAN" ? "RECOVERY_REQUIRED" : "FAILED",
        finishedAt,
        { message: describeError(error) },
      );
      return targetStatus === "NEEDS_HUMAN";
    } catch {
      return true;
    }
  }
}

function claimStatusForTask(
  status: Task["status"],
): "COMPLETED" | "FAILED" | "CANCELLED" | "RECOVERY_REQUIRED" {
  switch (status) {
    case "DONE":
      return "COMPLETED";
    case "CANCELLED":
      return "CANCELLED";
    case "BLOCKED":
    case "NEEDS_HUMAN":
      return "RECOVERY_REQUIRED";
    default:
      return "FAILED";
  }
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

function addLease(now: IsoTimestamp, durationMs: number): IsoTimestamp {
  const time = Date.parse(now);
  if (Number.isNaN(time)) {
    throw new Error(`execution claim clock returned an invalid timestamp: ${now}`);
  }
  return new Date(time + durationMs).toISOString();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
