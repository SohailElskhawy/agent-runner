import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  buildTaskFromManualInput,
  detectTaskConflicts,
  validateManualTaskInput,
  type PlanningInput,
  type PlanningResult,
  type ManualTaskInput,
  countParallelismActiveExecutions,
  evaluateParallelismCapacity,
  isParallelismActiveStatus,
  normalizeAndValidatePlan,
  parsePlanningResult,
  validatePlanningInput,
  TASK_STATUSES,
  type IntegrationQueueStatus,
  type Project,
  type ProjectConfiguration,
  type Task,
  type TaskId,
  type ExecutionClaim,
} from "@agentic-dev-runner/core";
import {
  createNodeProcessRunner,
  type ProcessRunner,
} from "@agentic-dev-runner/platform";
import { createExecutionClaimRecovery } from "@agentic-dev-runner/orchestrator";
import type {
  CrashRecovery,
  ExecutionClaimRecovery,
  IntegrationQueueProcessor,
  WorktreeRecovery,
  UnattendedScheduler,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import { CliError } from "../errors.js";
import { describeError } from "../io.js";
import {
  outcomeToRunResult,
  recoveryOutcomeToRunResult,
} from "./runner-app-service.js";
import type { RunnerAppService, TaskRunner } from "./runner-app-service.js";
import type {
  AddTaskResult,
  AgentStatusEntry,
  ApprovalCommandResult,
  ExecutionClaimStatusView,
  InitResult,
  ParallelCapacityUsage,
  ProjectStatus,
  RetryCommandResult,
  RunResult,
  SchedulerStatus,
  TaskInspection,
  TaskListEntry,
  UnattendedRunRequest,
  PlanPreview,
  PlanApprovalResult,
} from "./ports.js";
import { buildTaskInspection, toLatestAttemptSummary } from "./inspect-view.js";
import type { TaskStatusEntry } from "./ports.js";
import { readTaskFile } from "./task-file.js";
import { readPlanDraft } from "./planning/plan-files.js";
import type { PlanningOutcome } from "./planning/planner.js";
import { runDoctorChecks, type DoctorReport } from "./doctor.js";
import {
  DEFAULT_MAX_PARALLELISM,
  DEFAULT_PROJECT_ID,
  resolveWorktreesDir,
} from "./defaults.js";

export type StoreBackedAppServiceOptions = {
  readonly storePath: string;
  readonly projectRoot: string;
  readonly store: RunnerStore;
  readonly orchestrator: TaskRunner;
  readonly recovery: CrashRecovery;
  readonly executionClaimRecovery?: ExecutionClaimRecovery | undefined;
  readonly integrationRecovery?: IntegrationQueueProcessor | undefined;
  readonly worktreeRecovery?: WorktreeRecovery | undefined;
  readonly agents: AgentRegistry;
  readonly scheduler?: UnattendedScheduler | null | undefined;
  /** The configured unattended scheduling capacity, for capacity reporting. */
  readonly maxParallelism?: number | undefined;
  /** Process execution seam used by preflight checks to probe external tools. */
  readonly runner?: ProcessRunner | undefined;
  /** Task worktrees directory reported by `doctor`; defaults to the state dir layout. */
  readonly worktreesDir?: string | undefined;
  /** The configuration loaded at composition time, if any. */
  readonly configuration?: ProjectConfiguration | null | undefined;
  /** A tolerated configuration load failure, reported by `doctor`. */
  readonly configurationError?: string | null | undefined;
  readonly analyzeRepository?: (projectRoot: string, goal?: string, existingTaskIds?: readonly string[]) => Promise<PlanningInput>;
  readonly planRepository?: ((input: PlanningInput) => Promise<PlanningOutcome>) | null;
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
  private readonly orchestrator: TaskRunner;
  private readonly recovery: CrashRecovery;
  private readonly executionClaimRecovery: ExecutionClaimRecovery;
  private readonly integrationRecovery: IntegrationQueueProcessor | undefined;
  private readonly worktreeRecovery: WorktreeRecovery | undefined;
  private readonly agents: AgentRegistry;
  private readonly scheduler: UnattendedScheduler | null;
  private readonly maxParallelism: number;
  private readonly runner: ProcessRunner;
  private readonly worktreesDir: string;
  private readonly configuration: ProjectConfiguration | null;
  private readonly configurationError: string | null;
  private readonly analyzeRepository: StoreBackedAppServiceOptions["analyzeRepository"];
  private readonly planRepository: StoreBackedAppServiceOptions["planRepository"];
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
    this.runner = options.runner ?? createNodeProcessRunner();
    this.worktreesDir =
      options.worktreesDir ?? resolveWorktreesDir({ projectRoot: options.projectRoot });
    this.configuration = options.configuration ?? null;
    this.configurationError = options.configurationError ?? null;
    this.analyzeRepository = options.analyzeRepository;
    this.planRepository = options.planRepository;
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

  async approve(taskId: TaskId): Promise<ApprovalCommandResult> {
    await this.startupReconcile();
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" was not found in runner state`,
      };
    }
    if (!task.definition.approval.required) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" does not require human approval`,
      };
    }
    if (task.approvalGrantedAt !== undefined) {
      return {
        kind: "already-granted",
        taskId,
        message: `task "${taskId}" was already approved at ${task.approvalGrantedAt}`,
      };
    }
    if (task.status === "DONE" || task.status === "CANCELLED") {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" is ${task.status} and cannot be approved`,
      };
    }
    const grantedAt = new Date().toISOString();
    const granted = await this.store.transaction(async () => {
      const recorded = await this.store.approveTask(taskId, grantedAt);
      if (recorded) {
        await this.store.appendEvents([
          {
            type: "task.approval.granted",
            taskId,
            payload: { taskId },
            occurredAt: grantedAt,
          },
        ]);
      }
      return recorded;
    });
    return granted
      ? {
          kind: "granted",
          taskId,
          message: `approval granted for task "${taskId}"`,
        }
      : {
          kind: "already-granted",
          taskId,
          message: `task "${taskId}" was already approved`,
        };
  }

  async retry(taskId: TaskId): Promise<RetryCommandResult> {
    await this.startupReconcile();
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" was not found in runner state`,
      };
    }
    if (
      task.status !== "FAILED" &&
      task.status !== "NEEDS_HUMAN" &&
      task.status !== "BLOCKED"
    ) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" is ${task.status}; only FAILED, NEEDS_HUMAN, or BLOCKED tasks can be retried`,
      };
    }
    const attempts = await this.store.listAttempts({ taskId });
    const maxAttempts = task.definition.limits.maxAttempts;
    if (attempts.length >= maxAttempts) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" exhausted its attempt budget (${String(attempts.length)}/${String(maxAttempts)}); raise limits.max_attempts and re-add the task to allow another attempt`,
      };
    }
    if (task.definition.approval.required && task.approvalGrantedAt === undefined) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" requires human approval; run "agentic approve ${taskId}" first`,
      };
    }
    const occurredAt = new Date().toISOString();
    const previousStatus = task.status;
    const applied = await this.store.transaction(async () => {
      const moved = await this.store.transitionTaskStatusFrom(
        taskId,
        previousStatus,
        "READY",
        occurredAt,
      );
      if (!moved) {
        return false;
      }
      await this.store.appendEvents([
        {
          type: "task.retry.requested",
          taskId,
          payload: { previousStatus, attempts: attempts.length },
          occurredAt,
        },
        {
          type: "task.transitioned",
          taskId,
          payload: { from: previousStatus, to: "READY" },
          occurredAt,
        },
      ]);
      return true;
    });
    if (!applied) {
      return {
        kind: "rejected",
        taskId,
        message: `task "${taskId}" changed state while retrying (expected ${previousStatus}); inspect it with "agentic tasks" and retry again`,
      };
    }
    return {
      kind: "accepted",
      taskId,
      message: `task "${taskId}" returned to READY`,
    };
  }

  async run(taskId: TaskId): Promise<RunResult> {
    await this.startupReconcile();
    const recovery = await this.recovery.reconcileTask(taskId);
    const recoveryResult = recoveryOutcomeToRunResult(recovery);
    if (recoveryResult !== null) {
      return recoveryResult;
    }
    const outcome = await this.orchestrator.run(taskId);
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
        ...(task.definition.approval.required
          ? {
              approval: {
                required: true,
                granted: task.approvalGrantedAt !== undefined,
              },
            }
          : {}),
      });
    }
    const scheduler = await this.buildSchedulerStatus(tasks);
    return { project, tasks: entries, scheduler };
  }

  async listTaskSummaries(): Promise<readonly TaskListEntry[]> {
    await this.startupReconcile();
    const tasks = await this.store.listTasks();
    const entries: TaskListEntry[] = [];
    for (const task of tasks) {
      const attempts = await this.store.listAttempts({ taskId: task.id });
      entries.push({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        milestone: task.milestone,
        dependsOn: task.dependsOn,
        attemptCount: attempts.length,
        approvalRequired: task.definition.approval.required,
        approvalGranted: task.approvalGrantedAt !== undefined,
      });
    }
    return entries;
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

  async doctor(): Promise<DoctorReport> {
    try {
      await this.store.initialize();
    } catch (error) {
      throw new CliError(`runner state could not be opened: ${describeError(error)}`);
    }
    return await runDoctorChecks({
      nodeVersion: process.versions.node,
      projectRoot: this.projectRoot,
      storePath: this.storePath,
      worktreesDir: this.worktreesDir,
      configuration: this.configuration,
      configurationError: this.configurationError ?? null,
      projects: await this.store.listProjects(),
      agents: await this.listAgents(),
      runGitVersion: async () => {
        const result = await this.runner.run({
          executable: "git",
          args: ["--version"],
          timeoutMs: 10_000,
        });
        if (result.outcome.kind === "timeout") {
          return { ok: false, detail: "git --version timed out after 10000 ms" };
        }
        return result.outcome.kind === "completed" && result.outcome.code === 0
          ? { ok: true, detail: result.stdout.trim() }
          : {
              ok: false,
              detail:
                "git could not be executed; install Git and ensure it is on PATH",
            };
      },
      ensureWorktreesDir: async () => {
        try {
          await mkdir(this.worktreesDir, { recursive: true });
          const probe = join(
            this.worktreesDir,
            `.agentic-doctor-${String(process.pid)}-${String(Date.now())}`,
          );
          await writeFile(probe, "", "utf8");
          await rm(probe, { force: true });
          return { ok: true, detail: "writable" };
        } catch (error) {
          return { ok: false, detail: describeError(error) };
        }
      },
    });
  }

  async analyze(): Promise<PlanningInput> {
    await this.startupReconcile();
    const tasks = await this.store.listTasks();
    if (this.analyzeRepository === undefined) throw new CliError("repository analysis is not wired");
    return this.analyzeRepository(this.projectRoot, "", tasks.map((task) => task.id));
  }

  async plan(goal: string): Promise<PlanningOutcome> {
    await this.startupReconcile();
    if (this.planRepository == null || this.analyzeRepository === undefined) {
      throw new CliError('no planning profile is configured; set planning.profile in .agentic/config.json');
    }
    const tasks = await this.store.listTasks();
    const input = await this.analyzeRepository(this.projectRoot, goal, tasks.map((task) => task.id));
    return this.planRepository(input);
  }

  async showPlan(planId?: string): Promise<PlanPreview | null> {
    await this.startupReconcile();
    let selectedId = planId;
    if (selectedId === undefined) {
      const directory = join(this.projectRoot, ".agentic", "plans");
      const candidates = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const plans = await Promise.all(candidates
        .filter((entry) => entry.isDirectory() && /^plan-[a-f0-9]{16}$/.test(entry.name))
        .map(async (entry) => ({ id: entry.name, modified: (await stat(join(directory, entry.name, "plan.json")).catch(() => null))?.mtimeMs ?? -1 })));
      selectedId = plans.sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.id;
      if (selectedId === undefined) return null;
    }
    const draft = await readPlanDraft(this.projectRoot, selectedId);
    const validatedDraft = validatePlanDraft(draft, this.configuration?.verificationChecks.map((check) => check.name) ?? [], selectedId);
    const preview = validatedDraft.preview;
    const approvals = await this.store.listEvents({ type: "plan.approved" });
    const approval = approvals.find((event) => isPlanApprovalEvent(event.payload, selectedId));
    return {
      ...preview,
      approvalStatus: approval === undefined
        ? "draft"
        : isRecord(approval.payload) && approval.payload["previewDigest"] === validatedDraft.contentDigest
          ? "approved"
          : "changed",
    };
  }

  async approvePlan(planId: string): Promise<PlanApprovalResult> {
    await this.startupReconcile();
    const rejected = (message: string): PlanApprovalResult => ({ kind: "rejected", planId, taskIds: [], message });
    const alreadyApproved = (): PlanApprovalResult => rejected(`plan "${planId}" was already approved`);
    const priorEvents = await this.store.listEvents({ type: "plan.approved" });
    if (priorEvents.some((event) => isPlanApprovalEvent(event.payload, planId))) return alreadyApproved();

    let draft: ValidatedPlanDraft;
    try {
      draft = validatePlanDraft(
        await readPlanDraft(this.projectRoot, planId),
        this.configuration?.verificationChecks.map((check) => check.name) ?? [],
        planId,
      );
    } catch (error) {
      return rejected(describeError(error));
    }
    const project = await this.store.getProject(DEFAULT_PROJECT_ID);
    if (project === null) return rejected('runner is not initialized; run "agentic init" before approving plans');

    const approvedAt = new Date().toISOString();
    const committed = await this.store.transaction(async () => {
      const events = await this.store.listEvents({ type: "plan.approved" });
      if (events.some((event) => isPlanApprovalEvent(event.payload, planId))) return null;
      const planTaskIds = new Set(draft.tasks.map((task) => task.id));
      for (const task of draft.tasks) {
        if (await this.store.getTask(task.id) !== null) return { kind: "collision" as const, taskId: task.id };
      }
      for (const task of draft.tasks) {
        for (const dependency of task.dependsOn) {
          if (!planTaskIds.has(dependency) && await this.store.getTask(dependency) === null) {
            return { kind: "missing-dependency" as const, taskId: task.id, dependency };
          }
        }
      }
      const tasks = draft.tasks.map((task) => buildTaskFromManualInput(task, { projectId: project.id, now: approvedAt }));
      for (const task of tasks) await this.store.putTask(task);
      await this.store.appendEvents([{
        type: "plan.approved", taskId: null,
        payload: {
          planId, inputDigest: draft.preview.inputDigest,
          previewDigest: draft.contentDigest, taskIds: tasks.map((task) => task.id),
        },
        occurredAt: approvedAt,
      }]);
      return { kind: "approved" as const, tasks };
    });
    if (committed === null) return alreadyApproved();
    if (committed.kind === "collision") return rejected(`task "${committed.taskId}" already exists in runner state; plan approval was cancelled`);
    if (committed.kind === "missing-dependency") return rejected(`task "${committed.taskId}" depends on missing runner task "${committed.dependency}"`);

    const taskIds = committed.tasks.map((task) => task.id);
    return { kind: "approved", planId, taskIds, message: `approved plan "${planId}" with ${String(taskIds.length)} tasks` };
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


type ValidatedPlanDraft = { readonly preview: PlanPreview; readonly input: PlanningInput; readonly tasks: readonly ManualTaskInput[]; readonly contentDigest: string };

function validatePlanDraft(value: unknown, configuredVerificationChecks: readonly string[], expectedPlanId?: string): ValidatedPlanDraft {
  if (!isRecord(value) || typeof value["planId"] !== "string" || typeof value["inputDigest"] !== "string" || typeof value["summary"] !== "string" || !Array.isArray(value["tasks"])) {
    throw new CliError('plan draft is malformed; regenerate it with "agentic plan --goal"');
  }
  if (expectedPlanId !== undefined && value["planId"] !== expectedPlanId) throw new CliError("plan draft ID does not match its directory");
  const parsedResult = parsePlanningResult(value["result"]);
  if (!parsedResult.ok || parsedResult.value.kind !== "READY_FOR_PLANNING") {
    throw new CliError(`plan draft milestones or result are invalid: ${parsedResult.ok ? "expected READY_FOR_PLANNING" : parsedResult.issues.join("; ")}`);
  }
  const parsedInput = validatePlanningInput(value["input"]);
  if (!parsedInput.ok) throw new CliError(`plan draft input is invalid: ${parsedInput.issues.join("; ")}`);
  const parsedInputs = value["tasks"].map((task, index) => {
    const parsed = validateManualTaskInput(task);
    if (!parsed.ok) throw new CliError(`plan draft task ${String(index + 1)} is invalid: ${parsed.issues.join("; ")}`);
    return parsed.value;
  });
  const result: PlanningResult = {
    version: 1,
    kind: "READY_FOR_PLANNING",
    milestones: parsedResult.value.milestones,
    tasks: parsedInputs.map(toPlannerTask),
  };
  const validation = normalizeAndValidatePlan(result, {
    configuredVerificationChecks,
    existingTaskIds: parsedInput.value.existingTaskIds,
  });
  if (!validation.ok) throw new CliError(`plan draft tasks are invalid: ${validation.issues.join("; ")}`);
  const normalizedTasks = validation.tasks;
  const previewTasks = normalizedTasks.map((task) => ({
    id: task.id, title: task.title, milestone: task.milestone, dependsOn: task.dependsOn,
    approvalRequired: task.approval.required, objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria, allowedPaths: task.scope.allowedPaths, risk: task.risk,
  }));
  return {
    input: parsedInput.value,
    tasks: normalizedTasks,
    contentDigest: digestCanonicalPlanContent({
      planId: value["planId"], inputDigest: value["inputDigest"], summary: value["summary"],
      milestones: parsedResult.value.milestones, tasks: normalizedTasks,
    }),
    preview: {
      planId: value["planId"], inputDigest: value["inputDigest"], summary: value["summary"],
      milestones: parsedResult.value.milestones, tasks: previewTasks,
      parallelizableTaskCount: safeParallelSubset(normalizedTasks),
      conflicts: validation.conflicts,
      approvalStatus: "draft",
    },
  };
}

function toPlannerTask(task: ManualTaskInput): Readonly<Record<string, unknown>> {
  return {
    id: task.id,
    title: task.title,
    milestone: task.milestone,
    provenanceSource: task.provenance.source,
    risk: task.risk,
    type: task.type,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: task.dependsOn,
    allowedPaths: task.scope.allowedPaths,
    resources: task.resources,
    routing: task.routing,
    verification: task.verification.required,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function safeParallelSubset(tasks: readonly ManualTaskInput[]): number {
  const ready = tasks.filter((task) => task.dependsOn.length === 0 && !task.approval.required).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const selected: ManualTaskInput[] = [];
  for (const candidate of ready) {
    const conflicts = detectTaskConflicts([...selected, candidate].map((task) => buildTaskFromManualInput(task, {
      projectId: "planning", now: "1970-01-01T00:00:00.000Z",
    })));
    if (conflicts.length === 0) selected.push(candidate);
  }
  return selected.length;
}


function isPlanApprovalEvent(payload: unknown, planId: string): boolean {
  return isRecord(payload) && payload["planId"] === planId;
}

function digestCanonicalPlanContent(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
