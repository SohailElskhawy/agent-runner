/**
 * Resolved workflow lifecycle execution for one already-selected runnable
 * task.
 *
 * Wires the workflow definitions and stage resolution, the PLAN /
 * PLAN_REVIEW / IMPLEMENT / CODE_REVIEW stage primitives, the bounded
 * review/fix loops, the verification engine, and the vertical-slice Git
 * commit/integration path into a single deterministic workflow executor.
 *
 * The executor runs the required stages of the resolved workflow definition
 * in definition order. There is no scheduler, no DAG traversal, and no
 * parallelism: exactly one task, one attempt, one sequential stage
 * sequence. Every authoritative decision — task status transitions, gate
 * acceptance, verification, staging, commits, integration, and DONE — is
 * owned by the runner; stage agents only produce stage results and never
 * choose the next workflow step. A required gate that fails aborts
 * progression immediately, and DONE is persisted only after successful
 * integration.
 */

import { join } from "node:path";
import type {
  Attempt,
  AttemptId,
  IsoTimestamp,
  StageKind,
  StageRun,
  StageRunId,
  StageRunStatus,
  Task,
  TaskId,
  TaskStatus,
  WorkflowDefinition,
} from "@agentic-dev-runner/core";
import {
  STAGE_KINDS,
  assertTaskTransition,
  validateWorkflowDefinition,
} from "@agentic-dev-runner/core";
import type { AgentRuntime } from "@agentic-dev-runner/agents";
import type { GitIntegrationResult, GitManager } from "@agentic-dev-runner/git";
import type { NewEvent, RunnerStore } from "@agentic-dev-runner/persistence";
import type {
  VerificationCheckSpec,
  VerificationEngine,
  VerificationRunResult,
} from "@agentic-dev-runner/verification";
import {
  resolveVerificationChecksForTask,
  toVerificationResults,
} from "@agentic-dev-runner/verification";
import { OrchestrationError } from "./orchestration-error.js";
import {
  ORCHESTRATION_EVENTS,
  type AttemptStartedPayload,
  type CommitCreatedPayload,
  type ImplementationCompletedPayload,
  type IntegrationCompletedPayload,
  type IntegrationVerificationCompletedPayload,
  type TaskTransitionedPayload,
  type VerificationCompletedPayload,
  type WorktreeCleanupFailedPayload,
  type WorktreeCreatedPayload,
} from "./orchestration-events.js";
import type {
  CancelledTaskRun,
  CompletedTaskRun,
  FailedTaskRun,
  RejectedTaskRun,
  WorktreeCleanupOutcome,
} from "./orchestration-outcome.js";
import {
  resolveWorkflowFailure,
  WorkflowExecutionFailure,
} from "./workflow-failures.js";
import type {
  BlockedTaskRun,
  WorkflowTaskRunOutcome,
} from "./workflow-outcome.js";
import {
  executePlanReviewFixLoop,
  executeCodeReviewFixLoop,
  type PlanReviewFixLoopOptions,
} from "./review-fix-loop.js";
import { executePlanStage } from "./plan-stage.js";
import { executeImplementStage } from "./implement-stage.js";
import type { ImplementStageGuidance } from "./implement-stage.js";

export interface WorkflowTaskExecutor {
  run(): Promise<WorkflowTaskRunOutcome>;
}

export type WorkflowTaskExecutorOptions = {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly agent: AgentRuntime;
  readonly verification: VerificationEngine;
  readonly verificationChecks: readonly VerificationCheckSpec[];
  /** The already-selected runnable task to execute. */
  readonly task: Task;
  /** The resolved workflow definition controlling the required stages. */
  readonly workflow: WorkflowDefinition;
  readonly projectRoot: string;
  readonly worktreesDir: string;
  readonly agentTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export function createWorkflowTaskExecutor(
  options: WorkflowTaskExecutorOptions,
): WorkflowTaskExecutor {
  return new SequentialWorkflowTaskExecutor(options);
}

const PLAN_STAGE: StageKind = "PLAN";
const VERIFY_STAGE: StageKind = "VERIFY";
const INTEGRATE_STAGE: StageKind = "INTEGRATE";

class SequentialWorkflowTaskExecutor implements WorkflowTaskExecutor {
  private readonly store: RunnerStore;
  private readonly git: GitManager;
  private readonly agent: AgentRuntime;
  private readonly verification: VerificationEngine;
  private readonly verificationChecks: readonly VerificationCheckSpec[];
  private readonly taskId: TaskId;
  private readonly workflow: WorkflowDefinition;
  private readonly projectRoot: string;
  private readonly worktreesDir: string;
  private readonly agentTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly clock: () => IsoTimestamp;
  private running = false;

  constructor(options: WorkflowTaskExecutorOptions) {
    validateOptions(options);
    this.store = options.store;
    this.git = options.git;
    this.agent = options.agent;
    this.verification = options.verification;
    this.verificationChecks = [...options.verificationChecks];
    this.taskId = options.task.id;
    this.workflow = options.workflow;
    this.projectRoot = options.projectRoot;
    this.worktreesDir = options.worktreesDir;
    this.agentTimeoutMs = options.agentTimeoutMs;
    this.signal = options.signal;
    this.clock = options.now ?? defaultClock;
  }

  async run(): Promise<WorkflowTaskRunOutcome> {
    if (this.running) {
      throw new OrchestrationError(
        "A task is already executing in this executor; workflow execution is strictly sequential",
      );
    }
    this.running = true;
    try {
      return await this.execute();
    } finally {
      this.running = false;
    }
  }

  private async execute(): Promise<WorkflowTaskRunOutcome> {
    const taskId = this.taskId;
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return rejected(taskId, `task "${taskId}" not found`);
    }
    if (task.status !== "READY") {
      return rejected(
        taskId,
        `task "${taskId}" is not runnable because its status is "${task.status}"`,
        task.status,
      );
    }
    const workflowValidation = validateWorkflowDefinition(this.workflow);
    if (!workflowValidation.valid) {
      return rejected(
        taskId,
        `workflow "${this.workflow.id}" is not executable: ${describeWorkflowIssues(workflowValidation.issues)}`,
        task.status,
      );
    }
    const unsupportedStages = this.workflow.stages.filter(
      (stage) => !(STAGE_KINDS as readonly string[]).includes(stage),
    );
    if (unsupportedStages.length > 0) {
      return rejected(
        taskId,
        `workflow "${this.workflow.id}" contains stages that are not lifecycle stages: ${unsupportedStages.join(", ")}`,
        task.status,
      );
    }
    const stages = this.workflow.stages;
    const hasPlan = stages.includes("PLAN");
    const hasPlanReview = stages.includes("PLAN_REVIEW");
    const hasCodeReview = stages.includes("CODE_REVIEW");
    if (hasPlanReview && !hasPlan) {
      return rejected(
        taskId,
        `workflow "${this.workflow.id}" requires PLAN_REVIEW without PLAN; PLAN_REVIEW reviews the PLAN output of the same attempt, so the workflow must also require PLAN`,
        task.status,
      );
    }
    if (this.signal?.aborted === true) {
      return rejected(taskId, "execution was aborted before it started", task.status);
    }
    if (!(await this.git.isRepository(this.projectRoot))) {
      return rejected(
        taskId,
        `project root "${this.projectRoot}" is not a Git repository`,
        task.status,
      );
    }
    const verificationResolution = resolveVerificationChecksForTask(
      task.definition.verification.required,
      this.verificationChecks,
    );
    if (!verificationResolution.ok) {
      return rejected(
        taskId,
        `no verification command configured for required checks: ${verificationResolution.missingChecks.join(", ")}`,
        task.status,
      );
    }

    const baseRevision = await this.resolveBaseRevision(taskId, task.status);
    if (typeof baseRevision !== "string") {
      return baseRevision;
    }

    const created = await this.createAttempt(taskId, baseRevision, task.status);
    if (!created.ok) {
      return created.rejected;
    }
    const { attempt, attemptId, branch, worktreePath } = created;

    const loopOptions: PlanReviewFixLoopOptions = {
      store: this.store,
      git: this.git,
      agent: this.agent,
      task,
      attemptId,
      worktreePath,
      baseRevision,
      timeoutMs: this.agentTimeoutMs,
      signal: this.signal,
      now: this.clock,
    };

    let currentStatus: TaskStatus = task.status;
    let worktreeCreated = false;
    try {
      currentStatus = await this.transitionTask(taskId, currentStatus, "IMPLEMENTING", attemptId);

      await this.git.createBranch(this.projectRoot, branch);
      await this.git.createWorktree(this.projectRoot, worktreePath, branch);
      worktreeCreated = true;
      await this.store.appendEvents([
        {
          type: ORCHESTRATION_EVENTS.worktreeCreated,
          taskId,
          payload: {
            attemptId,
            branch,
            worktreePath,
            baseRevision,
          } satisfies WorktreeCreatedPayload,
          occurredAt: this.clock(),
        },
      ]);

      let implementGuidance: ImplementStageGuidance | undefined;

      if (hasPlan) {
        if (hasPlanReview) {
          const planLoop = await executePlanReviewFixLoop(loopOptions);
          if (planLoop.kind === "review-limit-exhausted") {
            throw new WorkflowExecutionFailure(
              "review_exhausted",
              describeReviewExhaustion("plan", planLoop.reviewCycles, planLoop.feedback),
            );
          }
          if (planLoop.kind === "failed") {
            throw terminalStageFailure(planLoop.stageRuns, planLoop.reason);
          }
          implementGuidance = { plan: approvedPlanOf(planLoop.stageRuns) };
        } else {
          const planOutcome = await executePlanStage({ ...loopOptions, cycle: 1 });
          if (planOutcome.kind === "failed") {
            throw terminalStageFailure([planOutcome.stageRun], planOutcome.reason);
          }
          implementGuidance = { plan: planOutcome.plan };
        }
      }

      if (hasCodeReview) {
        const codeLoop = await executeCodeReviewFixLoop({
          ...loopOptions,
          ...(implementGuidance?.plan === undefined
            ? {}
            : { initialPlan: implementGuidance.plan }),
        });
        if (codeLoop.kind === "review-limit-exhausted") {
          throw new WorkflowExecutionFailure(
            "review_exhausted",
            describeReviewExhaustion("code", codeLoop.reviewCycles, codeLoop.feedback),
          );
        }
        if (codeLoop.kind === "failed") {
          throw terminalStageFailure(codeLoop.stageRuns, codeLoop.reason);
        }
      } else {
        const implementOutcome = await executeImplementStage({
          ...loopOptions,
          cycle: 1,
          ...(implementGuidance === undefined ? {} : { guidance: implementGuidance }),
        });
        if (implementOutcome.kind === "failed") {
          throw terminalStageFailure(
            [implementOutcome.stageRun],
            implementOutcome.reason,
          );
        }
      }

      await this.git.stageAll(worktreePath);
      const worktreeStatus = await this.git.status(worktreePath);
      if (worktreeStatus.clean) {
        throw new WorkflowExecutionFailure(
          "error",
          "agent produced no usable code changes: the task worktree is clean",
        );
      }
      const changedPaths = worktreeStatus.entries.map((entry) => entry.path);

      currentStatus = await this.transitionTask(
        taskId,
        currentStatus,
        "VERIFYING",
        attemptId,
        [
          {
            type: ORCHESTRATION_EVENTS.implementationCompleted,
            taskId,
            payload: {
              attemptId,
              changedPaths,
            } satisfies ImplementationCompletedPayload,
            occurredAt: this.clock(),
          },
        ],
      );

      await this.runVerificationStage({
        attemptId,
        worktreePath,
        checks: verificationResolution.checks,
      });

      const commitMessage = `task ${taskId}: ${task.title}`;
      const commitRevision = await this.git.commitStaged(worktreePath, commitMessage);

      currentStatus = await this.transitionTask(
        taskId,
        currentStatus,
        "INTEGRATING",
        attemptId,
        [
          {
            type: ORCHESTRATION_EVENTS.commitCreated,
            taskId,
            payload: {
              attemptId,
              revision: commitRevision,
              message: commitMessage,
            } satisfies CommitCreatedPayload,
            occurredAt: this.clock(),
          },
        ],
      );

      const integration = await this.runIntegrationStage({
        attemptId,
        branch,
        checks: verificationResolution.checks,
      });

      const finishedAt = this.clock();
      const succeededAttempt: Attempt = {
        ...attempt,
        status: "SUCCEEDED",
        finishedAt,
      };
      await this.store.transaction(async () => {
        await this.store.setTaskStatus(taskId, "DONE", finishedAt);
        await this.store.putAttempt(succeededAttempt);
        await this.store.appendEvents([
          {
            type: ORCHESTRATION_EVENTS.taskTransitioned,
            taskId,
            payload: {
              from: currentStatus,
              to: "DONE",
              attemptId,
            } satisfies TaskTransitionedPayload,
            occurredAt: finishedAt,
          },
        ]);
      });
      currentStatus = "DONE";

      const finalTask = await this.requireTask(taskId);
      const cleanup = await this.cleanupWorktree(
        worktreeCreated,
        worktreePath,
        taskId,
        attemptId,
      );

      const outcome: CompletedTaskRun = {
        kind: "completed",
        taskId,
        attemptId,
        task: finalTask,
        attempt: succeededAttempt,
        branch,
        worktreePath,
        integration,
        cleanup,
      };
      return outcome;
    } catch (error) {
      return await this.failExecution({
        taskId,
        attempt,
        status: currentStatus,
        worktreeCreated,
        worktreePath,
        error,
      });
    }
  }

  private async resolveBaseRevision(
    taskId: TaskId,
    taskStatus: TaskStatus,
  ): Promise<string | RejectedTaskRun> {
    try {
      return await this.git.resolveHeadRevision(this.projectRoot);
    } catch (error) {
      return rejected(
        taskId,
        `failed to resolve the base revision: ${describeError(error)}`,
        taskStatus,
      );
    }
  }

  private async createAttempt(
    taskId: TaskId,
    baseRevision: string,
    taskStatus: TaskStatus,
  ): Promise<
    | {
        readonly ok: true;
        readonly attempt: Attempt;
        readonly attemptId: AttemptId;
        readonly branch: string;
        readonly worktreePath: string;
      }
    | { readonly ok: false; readonly rejected: RejectedTaskRun }
  > {
    const attempts = await this.store.listAttempts({ taskId });
    const attemptNumber =
      attempts.reduce<number>(
        (highest, existing) => Math.max(highest, existing.number),
        0,
      ) + 1;
    const attemptId: AttemptId = `att_${taskId}_${String(attemptNumber)}`;
    const branch = `task/${taskId}/attempt-${String(attemptNumber)}`;
    const worktreePath = join(
      this.worktreesDir,
      taskId,
      `attempt-${String(attemptNumber)}`,
    );
    const model = this.agent.descriptor.model;
    const startedAt = this.clock();
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "RUNNING",
      agent: this.agent.descriptor.id,
      ...(model === undefined ? {} : { model }),
      baseRevision,
      startedAt,
    };

    try {
      await this.store.transaction(async () => {
        await this.store.putAttempt(attempt);
        await this.store.appendEvents([
          {
            type: ORCHESTRATION_EVENTS.attemptStarted,
            taskId,
            payload: {
              attemptId,
              attemptNumber,
              agent: attempt.agent,
              baseRevision,
            } satisfies AttemptStartedPayload,
            occurredAt: startedAt,
          },
        ]);
      });
    } catch (error) {
      return {
        ok: false,
        rejected: rejected(
          taskId,
          `failed to create attempt: ${describeError(error)}`,
          taskStatus,
        ),
      };
    }
    return { ok: true, attempt, attemptId, branch, worktreePath };
  }

  /**
   * The VERIFY stage: one project-configured verification pass inside the
   * task worktree, persisted as a durable VERIFY StageRun and a
   * verification.completed event before any gate decision.
   */
  private async runVerificationStage(input: {
    attemptId: AttemptId;
    worktreePath: string;
    checks: readonly VerificationCheckSpec[];
  }): Promise<void> {
    const stageRunId: StageRunId = `stage_${input.attemptId}_VERIFY`;
    const startedAt = this.clock();
    await this.putStageRun({
      id: stageRunId,
      attemptId: input.attemptId,
      stage: VERIFY_STAGE,
      status: "RUNNING",
      startedAt,
    });

    let verificationRun: VerificationRunResult;
    try {
      verificationRun = await this.verification.run({
        attemptId: input.attemptId,
        cwd: input.worktreePath,
        checks: input.checks,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (error) {
      const message = `verification failed to run: ${describeError(error)}`;
      await this.finalizeStageRun(stageRunId, input.attemptId, VERIFY_STAGE, {
        status: "FAILED",
        failure: { kind: "error", message },
        startedAt,
      });
      throw new WorkflowExecutionFailure("error", message);
    }

    await this.store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.verificationCompleted,
        taskId: this.taskId,
        payload: {
          attemptId: input.attemptId,
          status: verificationRun.status,
          checks: toVerificationResults(verificationRun),
        } satisfies VerificationCompletedPayload,
        occurredAt: this.clock(),
      },
    ]);

    if (verificationRun.cancelled) {
      await this.finalizeStageRun(stageRunId, input.attemptId, VERIFY_STAGE, {
        status: "CANCELLED",
        failure: { kind: "cancelled", message: "verification was cancelled" },
        startedAt,
      });
      throw new WorkflowExecutionFailure("cancelled", "verification was cancelled");
    }
    if (!verificationRun.passed) {
      const message = `verification failed: ${describeVerificationFailures(verificationRun)}`;
      await this.finalizeStageRun(stageRunId, input.attemptId, VERIFY_STAGE, {
        status: "FAILED",
        failure: { kind: "error", message },
        startedAt,
      });
      throw new WorkflowExecutionFailure("verification_failed", message);
    }
    await this.finalizeStageRun(stageRunId, input.attemptId, VERIFY_STAGE, {
      status: "SUCCEEDED",
      startedAt,
    });
  }

  /**
   * The INTEGRATE stage: integrates the attempt branch into the integration
   * branch, then runs the project-configured verification against the
   * integrated result. Integration is not considered successful merely
   * because the task worktree passed verification; the INTEGRATE StageRun
   * becomes SUCCEEDED only after the integrated result passed the same
   * configured checks, and the verification evidence is persisted as a
   * distinct integration-verification event carrying the integrated
   * revision.
   */
  private async runIntegrationStage(input: {
    attemptId: AttemptId;
    branch: string;
    checks: readonly VerificationCheckSpec[];
  }): Promise<GitIntegrationResult> {
    const stageRunId: StageRunId = `stage_${input.attemptId}_INTEGRATE`;
    const startedAt = this.clock();
    await this.putStageRun({
      id: stageRunId,
      attemptId: input.attemptId,
      stage: INTEGRATE_STAGE,
      status: "RUNNING",
      startedAt,
    });

    let integration: GitIntegrationResult;
    try {
      integration = await this.git.integrateBranch(this.projectRoot, input.branch);
    } catch (error) {
      const message = `integration failed: ${describeError(error)}`;
      await this.finalizeStageRun(stageRunId, input.attemptId, INTEGRATE_STAGE, {
        status: "FAILED",
        failure: { kind: "error", message },
        startedAt,
      });
      throw new WorkflowExecutionFailure("error", message);
    }

    await this.store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.integrationCompleted,
        taskId: this.taskId,
        payload: {
          attemptId: input.attemptId,
          revision: integration.revision,
          kind: integration.kind,
        } satisfies IntegrationCompletedPayload,
        occurredAt: this.clock(),
      },
    ]);

    let integrationVerificationRun: VerificationRunResult;
    try {
      integrationVerificationRun = await this.verification.run({
        attemptId: input.attemptId,
        cwd: this.projectRoot,
        checks: input.checks,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (error) {
      const message = `integration verification failed to run: ${describeError(error)}`;
      await this.finalizeStageRun(stageRunId, input.attemptId, INTEGRATE_STAGE, {
        status: "FAILED",
        failure: { kind: "error", message },
        startedAt,
      });
      throw new WorkflowExecutionFailure("verification_failed", message);
    }

    await this.store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.integrationVerificationCompleted,
        taskId: this.taskId,
        payload: {
          attemptId: input.attemptId,
          revision: integration.revision,
          status: integrationVerificationRun.status,
          checks: toVerificationResults(integrationVerificationRun),
        } satisfies IntegrationVerificationCompletedPayload,
        occurredAt: this.clock(),
      },
    ]);

    if (integrationVerificationRun.cancelled) {
      await this.finalizeStageRun(stageRunId, input.attemptId, INTEGRATE_STAGE, {
        status: "CANCELLED",
        failure: {
          kind: "cancelled",
          message: "integration verification was cancelled",
        },
        startedAt,
      });
      throw new WorkflowExecutionFailure(
        "cancelled",
        "integration verification was cancelled",
      );
    }
    if (!integrationVerificationRun.passed) {
      const message = `integration verification failed: ${describeVerificationFailures(integrationVerificationRun)}`;
      await this.finalizeStageRun(stageRunId, input.attemptId, INTEGRATE_STAGE, {
        status: "FAILED",
        failure: { kind: "error", message },
        startedAt,
      });
      throw new WorkflowExecutionFailure("verification_failed", message);
    }

    await this.finalizeStageRun(stageRunId, input.attemptId, INTEGRATE_STAGE, {
      status: "SUCCEEDED",
      startedAt,
    });
    return integration;
  }

  private async transitionTask(
    taskId: TaskId,
    from: TaskStatus,
    to: TaskStatus,
    attemptId: string,
    evidenceEvents: readonly NewEvent[] = [],
  ): Promise<TaskStatus> {
    assertTaskTransition(from, to);
    const occurredAt = this.clock();
    await this.store.transaction(async () => {
      await this.store.setTaskStatus(taskId, to, occurredAt);
      await this.store.appendEvents([
        ...evidenceEvents,
        {
          type: ORCHESTRATION_EVENTS.taskTransitioned,
          taskId,
          payload: {
            from,
            to,
            attemptId,
          } satisfies TaskTransitionedPayload,
          occurredAt,
        },
      ]);
    });
    return to;
  }

  private async putStageRun(stageRun: {
    id: StageRunId;
    attemptId: AttemptId;
    stage: StageKind;
    status: StageRunStatus;
    startedAt: IsoTimestamp;
  }): Promise<void> {
    try {
      await this.store.putStageRun(stageRun);
    } catch (error) {
      throw new OrchestrationError(
        `failed to persist the RUNNING ${stageRun.stage} stage run "${stageRun.id}" for attempt "${stageRun.attemptId}": ${describeError(error)}`,
        error,
      );
    }
  }

  private async finalizeStageRun(
    stageRunId: StageRunId,
    attemptId: AttemptId,
    stage: StageKind,
    finalization: {
      readonly status: StageRunStatus;
      readonly failure?: StageRun["failure"] | undefined;
      readonly startedAt: IsoTimestamp;
    },
  ): Promise<void> {
    const stageRun: StageRun = {
      id: stageRunId,
      attemptId,
      stage,
      status: finalization.status,
      startedAt: finalization.startedAt,
      finishedAt: this.clock(),
      ...(finalization.failure === undefined
        ? {}
        : { failure: finalization.failure }),
    };
    try {
      await this.store.putStageRun(stageRun);
    } catch (error) {
      throw new OrchestrationError(
        `failed to persist the ${stageRun.status} ${stage} stage run "${stageRunId}" for attempt "${attemptId}": ${describeError(error)}`,
        error,
      );
    }
  }

  private async failExecution(input: {
    taskId: TaskId;
    attempt: Attempt;
    status: TaskStatus;
    worktreeCreated: boolean;
    worktreePath: string;
    error: unknown;
  }): Promise<FailedTaskRun | CancelledTaskRun | BlockedTaskRun> {
    if (input.status === "DONE") {
      throw new OrchestrationError(
        `the task already reached DONE; a post-completion operation failed: ${describeError(input.error)}`,
        input.error,
      );
    }
    const failure = toExecutionFailure(input.error);
    const resolution = resolveWorkflowFailure(failure.kind, failure.message);
    const finishedAt = this.clock();
    const finishedAttempt: Attempt = {
      ...input.attempt,
      status: resolution.attemptStatus,
      finishedAt,
      failure: resolution.attemptFailure,
    };
    try {
      await this.store.transaction(async () => {
        await this.store.setTaskStatus(input.taskId, resolution.taskStatus, finishedAt);
        await this.store.putAttempt(finishedAttempt);
        await this.store.appendEvents([
          {
            type: ORCHESTRATION_EVENTS.taskTransitioned,
            taskId: input.taskId,
            payload: {
              from: input.status,
              to: resolution.taskStatus,
              attemptId: input.attempt.id,
              failure: resolution.attemptFailure,
            } satisfies TaskTransitionedPayload,
            occurredAt: finishedAt,
          },
        ]);
      });
    } catch (persistError) {
      throw new OrchestrationError(
        `failed to persist the failure state for task "${input.taskId}" (original failure: ${failure.message}): ${describeError(persistError)}`,
        persistError,
      );
    }

    const task = await this.requireTask(input.taskId);
    const cleanup = await this.cleanupWorktree(
      input.worktreeCreated,
      input.worktreePath,
      input.taskId,
      input.attempt.id,
    );
    const outcome: FailedTaskRun | CancelledTaskRun | BlockedTaskRun = {
      kind: resolution.outcomeKind,
      taskId: input.taskId,
      task,
      attempt: finishedAttempt,
      reason: failure.message,
      cleanup,
    };
    return outcome;
  }

  private async cleanupWorktree(
    worktreeCreated: boolean,
    worktreePath: string,
    taskId: TaskId,
    attemptId: string,
  ): Promise<WorktreeCleanupOutcome | undefined> {
    if (!worktreeCreated) {
      return undefined;
    }
    let clean: boolean;
    try {
      clean = (await this.git.status(worktreePath)).clean;
    } catch {
      return { kind: "skipped", reason: "status-unavailable" };
    }
    if (!clean) {
      return { kind: "skipped", reason: "dirty-worktree" };
    }
    try {
      await this.git.removeWorktree(this.projectRoot, worktreePath);
      return { kind: "removed" };
    } catch (error) {
      const reason = describeError(error);
      try {
        await this.store.appendEvents([
          {
            type: ORCHESTRATION_EVENTS.worktreeCleanupFailed,
            taskId,
            payload: {
              attemptId,
              worktreePath,
              reason,
            } satisfies WorktreeCleanupFailedPayload,
            occurredAt: this.clock(),
          },
        ]);
      } catch {
        return { kind: "failed", message: reason };
      }
      return { kind: "failed", message: reason };
    }
  }

  private async requireTask(taskId: TaskId): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (task === null) {
      throw new OrchestrationError(`task "${taskId}" is missing from the store`);
    }
    return task;
  }
}

/**
 * The approved plan produced by a completed bounded plan review loop, taken
 * from the highest-cycle SUCCEEDED PLAN stage run of the loop. Selection is
 * identity-based, never based on persistence row order.
 */
function approvedPlanOf(stageRuns: readonly StageRun[]): string | undefined {
  let approvedCycle = -1;
  let approvedPlan: string | undefined;
  for (const stageRun of stageRuns) {
    if (stageRun.stage !== PLAN_STAGE || stageRun.status !== "SUCCEEDED") {
      continue;
    }
    const plan = stageRun.output?.plan;
    if (typeof plan !== "string" || plan.trim().length === 0) {
      continue;
    }
    const cycle = stageRunCycleOf(stageRun.id);
    if (cycle >= approvedCycle) {
      approvedCycle = cycle;
      approvedPlan = plan;
    }
  }
  return approvedPlan;
}

/**
 * Cycle number encoded in a deterministic stage-run identity produced by the
 * stage run-id builders: the base identity is cycle 1; `_cN` suffixes are
 * cycle N.
 */
function stageRunCycleOf(stageRunId: StageRunId): number {
  const marker = "_c";
  const index = stageRunId.lastIndexOf(marker);
  const suffix = index < 0 ? "" : stageRunId.slice(index + marker.length);
  return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : 1;
}

function describeReviewExhaustion(
  family: "plan" | "code",
  reviewCycles: number,
  feedback: string | undefined,
): string {
  const base =
    `${family} review-cycle budget exhausted: the review did not approve the ` +
    `output within ${String(reviewCycles)} review cycle(s)`;
  return typeof feedback === "string" && feedback.trim().length > 0
    ? `${base}; last review feedback: ${feedback}`
    : base;
}

/**
 * Maps a stage-primitive failure outcome onto the workflow failure kinds.
 * The terminal status of the failing stage run distinguishes timeout and
 * cancellation from ordinary stage errors.
 */
function terminalStageFailure(
  stageRuns: readonly StageRun[],
  reason: string,
): WorkflowExecutionFailure {
  const last = stageRuns[stageRuns.length - 1];
  if (last?.status === "TIMED_OUT") {
    return new WorkflowExecutionFailure("timeout", reason);
  }
  if (last?.status === "CANCELLED") {
    return new WorkflowExecutionFailure("cancelled", reason);
  }
  return new WorkflowExecutionFailure("error", reason);
}

function toExecutionFailure(error: unknown): WorkflowExecutionFailure {
  if (error instanceof WorkflowExecutionFailure) {
    return error;
  }
  return new WorkflowExecutionFailure("error", describeError(error));
}

function describeVerificationFailures(run: VerificationRunResult): string {
  return run.checks
    .filter((check) => check.outcome !== "PASSED")
    .map((check) => check.failure?.message ?? check.name)
    .join("; ");
}

function describeWorkflowIssues(
  issues: readonly { readonly reason: string }[],
): string {
  return issues.map((issue) => JSON.stringify(issue)).join("; ");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

function rejected(
  taskId: TaskId,
  reason: string,
  taskStatus?: TaskStatus,
): RejectedTaskRun {
  return {
    kind: "rejected",
    taskId,
    reason,
    ...(taskStatus === undefined ? {} : { taskStatus }),
  };
}

function validateOptions(options: WorkflowTaskExecutorOptions): void {
  if (options.task.id.trim().length === 0) {
    throw new OrchestrationError("task.id must be a non-empty string");
  }
  if (options.workflow.id.trim().length === 0) {
    throw new OrchestrationError("workflow.id must be a non-empty string");
  }
  if (options.projectRoot.length === 0) {
    throw new OrchestrationError("projectRoot must be a non-empty string");
  }
  if (options.worktreesDir.length === 0) {
    throw new OrchestrationError("worktreesDir must be a non-empty string");
  }
  if (!Number.isFinite(options.agentTimeoutMs) || options.agentTimeoutMs <= 0) {
    throw new OrchestrationError(
      "agentTimeoutMs must be a positive finite number",
    );
  }
  if (!Array.isArray(options.verificationChecks)) {
    throw new OrchestrationError("verificationChecks must be an array");
  }
  for (const check of options.verificationChecks) {
    if (typeof check.name !== "string" || check.name.length === 0) {
      throw new OrchestrationError(
        "every verification check must have a non-empty name",
      );
    }
    if (typeof check.executable !== "string" || check.executable.length === 0) {
      throw new OrchestrationError(
        `verification check "${check.name}" must have a non-empty executable`,
      );
    }
  }
}
