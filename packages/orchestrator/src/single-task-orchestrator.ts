import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Attempt,
  AttemptFailure,
  AttemptId,
  AttemptLogs,
  ContextPack,
  IsoTimestamp,
  Task,
  TaskId,
  TaskStatus,
} from "@agentic-dev-runner/core";
import { assertTaskTransition } from "@agentic-dev-runner/core";
import { buildContextPack } from "@agentic-dev-runner/context";
import type {
  AgentDescriptor,
  AgentOutput,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import type { GitManager } from "@agentic-dev-runner/git";
import type { GitStatusEntry } from "@agentic-dev-runner/git";
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
  describeTaskScopeViolations,
  validateTaskScope,
} from "./task-scope.js";
import {
  ORCHESTRATION_EVENTS,
  type AttemptStartedPayload,
  type CommitCreatedPayload,
  type ImplementationCompletedPayload,
  type IntegrationCompletedPayload,
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
  SingleTaskRunOutcome,
  WorktreeCleanupOutcome,
} from "./orchestration-outcome.js";

export interface SingleTaskOrchestrator {
  run(taskId: TaskId): Promise<SingleTaskRunOutcome>;
}

export type SingleTaskOrchestratorOptions = {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly agent: AgentRuntime;
  readonly verification: VerificationEngine;
  readonly verificationChecks: readonly VerificationCheckSpec[];
  readonly projectRoot: string;
  readonly worktreesDir: string;
  readonly agentTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export function createSingleTaskOrchestrator(
  options: SingleTaskOrchestratorOptions,
): SingleTaskOrchestrator {
  return new SequentialTaskOrchestrator(options);
}

class ExecutionFailure extends Error {
  readonly kind: AttemptFailure["kind"];

  constructor(kind: AttemptFailure["kind"], message: string) {
    super(message);
    this.name = "ExecutionFailure";
    this.kind = kind;
  }
}

class SequentialTaskOrchestrator implements SingleTaskOrchestrator {
  private readonly store: RunnerStore;
  private readonly git: GitManager;
  private readonly agent: AgentRuntime;
  private readonly verification: VerificationEngine;
  private readonly verificationChecks: readonly VerificationCheckSpec[];
  private readonly projectRoot: string;
  private readonly worktreesDir: string;
  private readonly agentTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly clock: () => IsoTimestamp;
  private running = false;

  constructor(options: SingleTaskOrchestratorOptions) {
    validateOptions(options);
    this.store = options.store;
    this.git = options.git;
    this.agent = options.agent;
    this.verification = options.verification;
    this.verificationChecks = [...options.verificationChecks];
    this.projectRoot = options.projectRoot;
    this.worktreesDir = options.worktreesDir;
    this.agentTimeoutMs = options.agentTimeoutMs;
    this.signal = options.signal;
    this.clock = options.now ?? defaultClock;
  }

  async run(taskId: TaskId): Promise<SingleTaskRunOutcome> {
    if (this.running) {
      throw new OrchestrationError(
        "A task is already executing in this orchestrator; single-task orchestration is strictly sequential",
      );
    }
    this.running = true;
    try {
      return await this.execute(taskId);
    } finally {
      this.running = false;
    }
  }

  private async execute(taskId: TaskId): Promise<SingleTaskRunOutcome> {
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
    if (this.signal?.aborted === true) {
      return rejected(
        taskId,
        "execution was aborted before it started",
        task.status,
      );
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
    let attempt: Attempt = {
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
      return rejected(
        taskId,
        `failed to create attempt: ${describeError(error)}`,
        task.status,
      );
    }

    let currentStatus: TaskStatus = task.status;
    let worktreeCreated = false;
    try {
      currentStatus = await this.transitionTask(
        taskId,
        currentStatus,
        "IMPLEMENTING",
        attemptId,
      );

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

      const contextPack = await this.buildContextPack(
        task,
        worktreePath,
        baseRevision,
      );
      attempt = { ...attempt, contextManifest: contextPack.manifest };
      await this.store.putAttempt(attempt);

      const agentResult = await this.agent.invoke({
        agent: agentDescriptorOf(this.agent),
        contextPack,
        worktreePath,
        timeoutMs: this.agentTimeoutMs,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });

      const logs = attemptLogsFrom(agentResult.output);
      attempt = logs === undefined ? attempt : { ...attempt, logs };
      await this.store.putAttempt(attempt);

      if (agentResult.kind === "failure") {
        throw new ExecutionFailure(
          "error",
          `agent failed: ${agentResult.failure.message}`,
        );
      }
      if (agentResult.kind === "timeout") {
        throw new ExecutionFailure(
          "timeout",
          `agent invocation timed out after ${String(this.agentTimeoutMs)} ms`,
        );
      }
      if (agentResult.kind === "cancelled") {
        throw new ExecutionFailure("cancelled", "agent invocation was cancelled");
      }

      await this.git.stageAll(worktreePath);
      const worktreeStatus = await this.git.status(worktreePath);
      if (worktreeStatus.clean) {
        throw new ExecutionFailure(
          "error",
          "agent produced no usable code changes: the task worktree is clean",
        );
      }
      const changedPaths = worktreeStatus.entries.map((entry) => entry.path);
      const scopeValidation = validateTaskScope(
        scopedPathsOf(worktreeStatus.entries),
        task.definition.scope,
      );
      if (!scopeValidation.ok) {
        throw new ExecutionFailure(
          "error",
          `task scope violation: the following changed paths are outside the task scope: ${describeTaskScopeViolations(scopeValidation.violations)}`,
        );
      }

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

      const verificationRun = await this.verification.run({
        attemptId,
        cwd: worktreePath,
        checks: verificationResolution.checks,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });

      await this.store.appendEvents([
        {
          type: ORCHESTRATION_EVENTS.verificationCompleted,
          taskId,
          payload: {
            attemptId,
            status: verificationRun.status,
            checks: toVerificationResults(verificationRun),
          } satisfies VerificationCompletedPayload,
          occurredAt: this.clock(),
        },
      ]);

      if (verificationRun.cancelled) {
        throw new ExecutionFailure("cancelled", "verification was cancelled");
      }
      if (!verificationRun.passed) {
        throw new ExecutionFailure(
          "verification_failed",
          `verification failed: ${describeVerificationFailures(verificationRun)}`,
        );
      }

      const commitMessage = `task ${taskId}: ${task.title}`;
      const commitRevision = await this.git.commitStaged(
        worktreePath,
        commitMessage,
      );

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

      const integration = await this.git.integrateBranch(
        this.projectRoot,
        branch,
      );

      await this.store.appendEvents([
        {
          type: ORCHESTRATION_EVENTS.integrationCompleted,
          taskId,
          payload: {
            attemptId,
            revision: integration.revision,
            kind: integration.kind,
          } satisfies IntegrationCompletedPayload,
          occurredAt: this.clock(),
        },
      ]);

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
      attempt = succeededAttempt;
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
        attempt,
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

  private async buildContextPack(
    task: Task,
    worktreePath: string,
    baseRevision: string,
  ): Promise<ContextPack> {
    let agentsMarkdown: string;
    try {
      agentsMarkdown = await readFile(join(worktreePath, "AGENTS.md"), "utf8");
    } catch (error) {
      throw new ExecutionFailure(
        "error",
        `mandatory project rules document "AGENTS.md" is missing or unreadable in the task worktree (${describeError(error)})`,
      );
    }
    try {
      return buildContextPack({
        task,
        agentsMarkdown,
        agentsMarkdownPath: "AGENTS.md",
        baseRevision,
        createdAt: this.clock(),
      });
    } catch (error) {
      throw new ExecutionFailure(
        "error",
        `failed to build the context pack: ${describeError(error)}`,
      );
    }
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

  private async failExecution(input: {
    taskId: TaskId;
    attempt: Attempt;
    status: TaskStatus;
    worktreeCreated: boolean;
    worktreePath: string;
    error: unknown;
  }): Promise<FailedTaskRun | CancelledTaskRun> {
    if (input.status === "DONE") {
      throw new OrchestrationError(
        `the task already reached DONE; a post-completion operation failed: ${describeError(input.error)}`,
        input.error,
      );
    }
    const failure = toExecutionFailure(input.error);
    const attemptStatus = attemptStatusForFailure(failure.kind);
    const taskStatus: TaskStatus =
      failure.kind === "cancelled" ? "CANCELLED" : "FAILED";
    const finishedAt = this.clock();
    const finishedAttempt: Attempt = {
      ...input.attempt,
      status: attemptStatus,
      finishedAt,
      failure: { kind: failure.kind, message: failure.message },
    };
    try {
      await this.store.transaction(async () => {
        await this.store.setTaskStatus(input.taskId, taskStatus, finishedAt);
        await this.store.putAttempt(finishedAttempt);
        await this.store.appendEvents([
          {
            type: ORCHESTRATION_EVENTS.taskTransitioned,
            taskId: input.taskId,
            payload: {
              from: input.status,
              to: taskStatus,
              attemptId: input.attempt.id,
              failure: { kind: failure.kind, message: failure.message },
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
    const outcome: FailedTaskRun | CancelledTaskRun = {
      kind: taskStatus === "CANCELLED" ? "cancelled" : "failed",
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

function agentDescriptorOf(agent: AgentRuntime): AgentDescriptor {
  return {
    id: agent.descriptor.id,
    ...(agent.descriptor.model === undefined
      ? {}
      : { model: agent.descriptor.model }),
  };
}

function scopedPathsOf(
  entries: readonly GitStatusEntry[],
): readonly string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    paths.push(entry.path);
    if (entry.previousPath !== undefined) {
      paths.push(entry.previousPath);
    }
  }
  return paths;
}

function attemptLogsFrom(output: AgentOutput): AttemptLogs | undefined {
  const stdout = output.stdout;
  const stderr = output.stderr;
  if (stdout === undefined && stderr === undefined) {
    return undefined;
  }
  return {
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

function toExecutionFailure(error: unknown): ExecutionFailure {
  if (error instanceof ExecutionFailure) {
    return error;
  }
  return new ExecutionFailure("error", describeError(error));
}

function attemptStatusForFailure(
  kind: AttemptFailure["kind"],
): Attempt["status"] {
  switch (kind) {
    case "timeout":
      return "TIMED_OUT";
    case "cancelled":
      return "CANCELLED";
    case "verification_failed":
    case "error":
      return "FAILED";
  }
}

function describeVerificationFailures(run: VerificationRunResult): string {
  return run.checks
    .filter((check) => check.outcome !== "PASSED")
    .map((check) => check.failure?.message ?? check.name)
    .join("; ");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

function validateOptions(options: SingleTaskOrchestratorOptions): void {
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
