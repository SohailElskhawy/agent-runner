import { basename } from "node:path";
import {
  buildTaskFromManualInput,
  countParallelismActiveExecutions,
  evaluateParallelismCapacity,
  isParallelismActiveStatus,
  TASK_STATUSES,
  validateManualTaskInput,
  type IntegrationQueueStatus,
  type Project,
  type Task,
  type TaskId,
  type ExecutionClaim,
} from "@agentic-dev-runner/core";
import { createExecutionClaimRecovery } from "@agentic-dev-runner/orchestrator";
import type {
  CrashRecovery,
  ExecutionClaimRecovery,
  IntegrationQueueProcessor,
  WorktreeRecovery,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
  UnattendedScheduler,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import { CliError } from "../errors.js";
import {
  outcomeToRunResult,
  recoveryOutcomeToRunResult,
} from "./runner-app-service.js";
import type { RunnerAppService } from "./runner-app-service.js";
import type {
  AddTaskResult,
  AgentStatusEntry,
  ExecutionClaimStatusView,
  InitResult,
  ParallelCapacityUsage,
  ProjectStatus,
  RunResult,
  SchedulerStatus,
  TaskInspection,
  UnattendedRunRequest,
} from "./ports.js";
import { buildTaskInspection, toLatestAttemptSummary } from "./inspect-view.js";
import type { TaskStatusEntry } from "./ports.js";
import { readTaskFile } from "./task-file.js";
import { DEFAULT_MAX_PARALLELISM, DEFAULT_PROJECT_ID } from "./defaults.js";

export type StoreBackedAppServiceOptions = {
  readonly storePath: string;
  readonly projectRoot: string;
  readonly store: RunnerStore;
  readonly orchestrator: SingleTaskOrchestrator;
  readonly recovery: CrashRecovery;
  readonly executionClaimRecovery?: ExecutionClaimRecovery | undefined;
  readonly integrationRecovery?: IntegrationQueueProcessor | undefined;
  readonly worktreeRecovery?: WorktreeRecovery | undefined;
  readonly agents: AgentRegistry;
  readonly scheduler?: UnattendedScheduler | null | undefined;
  /** The configured unattended scheduling capacity, for capacity reporting. */
  readonly maxParallelism?: number | undefined;
};

export function createStoreBackedAppService(
  options: StoreBackedAppServiceOptions,
): RunnerAppService {
  return new StoreBackedAppService(options);
}

class StoreBackedAppService implements RunnerAppService {
  private readonly storePath: string;
  private readonly projectRoot: string;
  private readonly store: RunnerStore;
  private readonly orchestrator: SingleTaskOrchestrator;
  private readonly recovery: CrashRecovery;
  private readonly executionClaimRecovery: ExecutionClaimRecovery;
  private readonly integrationRecovery: IntegrationQueueProcessor | undefined;
  private readonly worktreeRecovery: WorktreeRecovery | undefined;
  private readonly agents: AgentRegistry;
  private readonly scheduler: UnattendedScheduler | null;
  private readonly maxParallelism: number;
  private startupReconciliation: Promise<void> | undefined;

  constructor(options: StoreBackedAppServiceOptions) {
    this.storePath = options.storePath;
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.recovery = options.recovery;
    this.executionClaimRecovery = options.executionClaimRecovery ?? createExecutionClaimRecovery({
      store: options.store,
      recovery: options.recovery,
    });
    this.integrationRecovery = options.integrationRecovery;
    this.worktreeRecovery = options.worktreeRecovery;
    this.agents = options.agents;
    this.scheduler = options.scheduler ?? null;
    this.maxParallelism = options.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
  }

  async init(): Promise<InitResult> {
    await this.startupReconcile();
    const existing = await this.store.getProject(DEFAULT_PROJECT_ID);
    if (existing === null) {
      const now = new Date().toISOString();
      const project: Project = {
        id: DEFAULT_PROJECT_ID,
        name: basename(this.projectRoot) || this.projectRoot,
        rootPath: this.projectRoot,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.putProject(project);
    }
    return {
      projectId: DEFAULT_PROJECT_ID,
      projectRoot: this.projectRoot,
      storePath: this.storePath,
    };
  }

  async addTask(taskFilePath: string): Promise<AddTaskResult> {
    await this.startupReconcile();
    const validation = validateManualTaskInput(readTaskFile(taskFilePath));
    if (!validation.ok) {
      throw new CliError(
        `invalid task definition in "${taskFilePath}": ${validation.issues.join("; ")}`,
      );
    }
    const project = (await this.store.listProjects()).at(0) ?? null;
    if (project === null) {
      throw new CliError(
        'runner is not initialized; run "agentic init" before adding tasks',
      );
    }
    const now = new Date().toISOString();
    const task = buildTaskFromManualInput(validation.value, {
      projectId: project.id,
      now,
    });
    await this.store.transaction(async () => {
      const existing = await this.store.getTask(task.id);
      if (existing !== null) {
        throw new CliError(
          `task "${task.id}" already exists in runner state; duplicate task IDs are rejected`,
        );
      }
      await this.store.putTask(task);
    });
    return {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
    };
  }

  async run(taskId: TaskId): Promise<RunResult> {
    await this.startupReconcile();
    const recovery = await this.recovery.reconcileTask(taskId);
    const recoveryResult = recoveryOutcomeToRunResult(recovery);
    if (recoveryResult !== null) {
      return recoveryResult;
    }
    const outcome: SingleTaskRunOutcome = await this.orchestrator.run(taskId);
    return outcomeToRunResult(outcome);
  }

  async runUnattended(options: UnattendedRunRequest = {}): Promise<RunResult> {
    await this.startupReconcile();
    if (this.scheduler === null) {
      return {
        kind: "rejected",
        message: "unattended scheduling is unavailable for this application composition",
      };
    }
    const outcome = await this.scheduler.run({
      ...(options.maxParallelism === undefined
        ? {}
        : { maxParallelism: options.maxParallelism }),
    });
    const tasks = await this.store.listTasks();
    const summary = summarizeTaskStates(tasks);
    return outcome.kind === "quiescent"
      ? {
          kind: "completed",
          message:
            `unattended run reached quiescence after ${String(outcome.cycles.length)} cycle(s); ` +
            summary,
        }
      : {
          kind: "failed",
          message:
            `unattended run is blocked after ${String(outcome.cycles.length)} cycle(s); ` +
            summary,
        };
  }

  async status(): Promise<ProjectStatus> {
    await this.startupReconcile();
    const project = (await this.store.listProjects()).at(0) ?? null;
    const tasks = await this.store.listTasks();
    const entries: TaskStatusEntry[] = [];
    for (const task of tasks) {
      const attempts = await this.store.listAttempts({ taskId: task.id });
      entries.push({
        id: task.id,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt,
        attemptCount: attempts.length,
        latestAttempt: toLatestAttemptSummary(attempts.at(-1)),
      });
    }
    const scheduler = await this.buildSchedulerStatus(tasks);
    return { project, tasks: entries, scheduler };
  }

  async inspect(taskId: TaskId): Promise<TaskInspection | null> {
    await this.startupReconcile();
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return null;
    }
    const attempts = await this.store.listAttempts({ taskId });
    const events = await this.store.listEvents({ taskId });
    const stageRunBatches = await Promise.all(
      attempts.map((attempt) => this.store.listStageRuns(attempt.id)),
    );
    const claims = await this.store.listExecutionClaims({ taskId });
    const integrationQueue = await this.store.listIntegrationQueueEntries({
      taskId,
    });
    return buildTaskInspection({
      task,
      attempts,
      stageRuns: stageRunBatches.flat(),
      events,
      claims,
      integrationQueue,
    });
  }

  async listAgents(): Promise<readonly AgentStatusEntry[]> {
    const agents = await this.agents.discoverAgents();
    return agents.map((agent) => ({
      id: agent.id,
      available: agent.available,
      version: agent.version,
      reason: agent.reason,
    }));
  }

  async close(): Promise<void> {
    await this.store.close();
    this.startupReconciliation = undefined;
  }

  /**
   * Derives the scheduler-aware project snapshot from persisted authoritative
   * state: task states, execution claims, integration queue entries, and the
   * configured parallelism capacity. No CLI-only runtime state is involved.
   */
  private async buildSchedulerStatus(
    tasks: readonly Task[],
  ): Promise<SchedulerStatus> {
    const totalsByState = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, 0]),
    ) as Record<Task["status"], number>;
    for (const task of tasks) {
      totalsByState[task.status] += 1;
    }
    const activeClaims = await this.store.listExecutionClaims({
      status: "ACTIVE",
    });
    const recoveryRequiredClaims = await this.store.listExecutionClaims({
      status: "RECOVERY_REQUIRED",
    });
    const queueEntries = await this.store.listIntegrationQueueEntries();
    const queueTotals = Object.fromEntries(
      ["PENDING", "INTEGRATING", "COMPLETED", "FAILED"].map((status) => [
        status,
        0,
      ]),
    ) as Record<IntegrationQueueStatus, number>;
    for (const entry of queueEntries) {
      queueTotals[entry.status] += 1;
    }
    const activeExecutions = Math.max(
      activeClaims.length,
      countParallelismActiveExecutions(tasks.map((task) => task.status)),
    );
    const capacityDecision = evaluateParallelismCapacity({
      maxParallelism: this.maxParallelism,
      activeExecutions,
    });
    const capacity: ParallelCapacityUsage = {
      maxParallelism: capacityDecision.maxParallelism,
      activeExecutions: capacityDecision.activeExecutions,
      remainingSlots: capacityDecision.remainingSlots,
    };
    const integrating = queueEntries.find(
      (entry) => entry.status === "INTEGRATING",
    );
    return {
      totalsByState,
      activeTaskIds: tasks
        .filter((task) => isParallelismActiveStatus(task.status))
        .map((task) => task.id),
      blockedTaskIds: tasks
        .filter((task) => task.status === "BLOCKED")
        .map((task) => task.id),
      failedTaskIds: tasks
        .filter((task) => task.status === "FAILED")
        .map((task) => task.id),
      recoveryRequiredTaskIds: tasks
        .filter((task) => task.status === "NEEDS_HUMAN")
        .map((task) => task.id),
      activeClaims: activeClaims.map(toClaimView),
      recoveryRequiredClaims: recoveryRequiredClaims.map(toClaimView),
      integrationQueue: {
        totalsByStatus: queueTotals,
        pendingTaskIds: queueEntries
          .filter((entry) => entry.status === "PENDING")
          .map((entry) => entry.taskId),
        integrating:
          integrating === undefined
            ? null
            : { taskId: integrating.taskId, attemptId: integrating.attemptId },
      },
      parallelCapacity: capacity,
    };
  }

  private startupReconcile(): Promise<void> {    this.startupReconciliation ??= (async () => {
      await this.store.initialize();
      const integration = await this.integrationRecovery?.recoverAbandoned() ?? [];
      const claims = await this.executionClaimRecovery.reconcileExpired();
      const activeClaims = await this.store.listExecutionClaims({ status: "ACTIVE" });
      await this.recovery.reconcileUnfinished(activeClaims.map((claim) => claim.taskId));
      const worktrees = await this.worktreeRecovery?.reconcileTerminalWorktrees() ?? [];
      await this.recordStartupRecovery(integration, claims, worktrees);
    })();
    return this.startupReconciliation;
  }

  private async recordStartupRecovery(
    integration: readonly { readonly kind: string; readonly entry?: { readonly taskId: string } }[],
    claims: readonly { readonly kind: string; readonly claim: { readonly taskId: string } }[],
    worktrees: readonly { readonly kind: string; readonly taskId: string }[],
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    await this.store.appendEvents([
      ...integration.map((outcome) => ({
        type: "recovery.startup.integration",
        taskId: outcome.entry?.taskId ?? null,
        payload: { kind: outcome.kind },
        occurredAt,
      })),
      ...claims.map((outcome) => ({
        type: "recovery.startup.execution-claim",
        taskId: outcome.claim.taskId,
        payload: { kind: outcome.kind },
        occurredAt,
      })),
      ...worktrees.map((outcome) => ({
        type: "recovery.startup.worktree",
        taskId: outcome.taskId,
        payload: { kind: outcome.kind },
        occurredAt,
      })),
    ]);
  }
}

function toClaimView(claim: ExecutionClaim): ExecutionClaimStatusView {
  return {
    executionId: claim.id,
    taskId: claim.taskId,
    status: claim.status,
    claimedAt: claim.claimedAt,
    renewedAt: claim.renewedAt,
    leaseExpiresAt: claim.leaseExpiresAt,
  };
}

/**
 * Deterministic summary of the final persisted task states for a completed
 * run. A run containing failed or blocked tasks alongside successful
 * independent progress is reported accurately instead of crashing.
 */
export function summarizeTaskStates(tasks: readonly Task[]): string {
  const counts = new Map<Task["status"], number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const breakdown = ordered
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  return `final persisted task state: ${breakdown.length === 0 ? "no tasks" : breakdown}`;
}
