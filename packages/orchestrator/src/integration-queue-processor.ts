import { join } from "node:path";
import type {
  Attempt,
  AttemptFailure,
  IntegrationQueueEntry,
  IsoTimestamp,
  StageRun,
  Task,
} from "@agentic-dev-runner/core";
import { assertTaskTransition } from "@agentic-dev-runner/core";
import type {
  GitIntegrationResult,
  GitManager,
} from "@agentic-dev-runner/git";
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
import {
  ORCHESTRATION_EVENTS,
  type IntegrationCompletedPayload,
  type IntegrationVerificationCompletedPayload,
  type TaskTransitionedPayload,
  type VerificationCompletedPayload,
} from "./orchestration-events.js";
import type { IntegrationDriftService } from "./integration-drift.js";
import { createIntegrationDriftService } from "./integration-drift.js";
import { OrchestrationError } from "./orchestration-error.js";

export type IntegrationQueueProcessorOptions = {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly verification: VerificationEngine;
  readonly verificationChecks: readonly VerificationCheckSpec[];
  readonly projectRoot: string;
  readonly worktreesDir: string;
  readonly drift?: IntegrationDriftService | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export type IntegrationQueueProcessorOutcome =
  | { readonly kind: "empty" }
  | {
      readonly kind: "blocked";
      readonly activeEntry: IntegrationQueueEntry;
    }
  | {
      readonly kind: "processed";
      readonly entry: IntegrationQueueEntry;
      readonly taskRevision: string;
      readonly integration: GitIntegrationResult;
    }
  | {
      readonly kind: "failed";
      readonly entry: IntegrationQueueEntry;
      readonly taskRevision: string;
      readonly reason: string;
      readonly recoveryRequired?: boolean | undefined;
    };

export interface IntegrationQueueProcessor {
  /** Claims and settles at most one durable queue entry. */
  processNext(): Promise<IntegrationQueueProcessorOutcome>;
}

export function createIntegrationQueueProcessor(
  options: IntegrationQueueProcessorOptions,
): IntegrationQueueProcessor {
  return new DurableIntegrationQueueProcessor(options);
}

class QueueProcessingFailure extends Error {
  readonly kind: AttemptFailure["kind"];

  constructor(kind: AttemptFailure["kind"], message: string) {
    super(message);
    this.name = "QueueProcessingFailure";
    this.kind = kind;
  }
}

class DurableIntegrationQueueProcessor implements IntegrationQueueProcessor {
  private readonly store: RunnerStore;
  private readonly git: GitManager;
  private readonly verification: VerificationEngine;
  private readonly verificationChecks: readonly VerificationCheckSpec[];
  private readonly projectRoot: string;
  private readonly worktreesDir: string;
  private readonly drift: IntegrationDriftService;
  private readonly clock: () => IsoTimestamp;
  private processing = false;

  constructor(options: IntegrationQueueProcessorOptions) {
    if (options.projectRoot.length === 0) {
      throw new OrchestrationError("projectRoot must be a non-empty string");
    }
    if (options.worktreesDir.length === 0) {
      throw new OrchestrationError("worktreesDir must be a non-empty string");
    }
    this.store = options.store;
    this.git = options.git;
    this.verification = options.verification;
    this.verificationChecks = [...options.verificationChecks];
    this.projectRoot = options.projectRoot;
    this.worktreesDir = options.worktreesDir;
    this.drift =
      options.drift ??
      createIntegrationDriftService({
        git: options.git,
        projectRoot: options.projectRoot,
      });
    this.clock = options.now ?? defaultClock;
  }

  async processNext(): Promise<IntegrationQueueProcessorOutcome> {
    if (this.processing) {
      throw new OrchestrationError(
        "integration queue processing is already in progress",
      );
    }
    this.processing = true;
    try {
      const entry = await this.store.claimNextIntegrationQueueEntry(this.clock());
      if (entry === null) {
        const active = await this.store.listIntegrationQueueEntries({
          status: "INTEGRATING",
        });
        const activeEntry = active[0];
        return activeEntry === undefined
          ? { kind: "empty" }
          : { kind: "blocked", activeEntry };
      }
      return await this.processClaimed(entry);
    } finally {
      this.processing = false;
    }
  }

  private async processClaimed(
    entry: IntegrationQueueEntry,
  ): Promise<IntegrationQueueProcessorOutcome> {
    let taskRevision = entry.taskRevision;
    try {
      const task = await this.requireTask(entry.taskId);
      const attempt = await this.requireAttempt(entry.attemptId);
      if (task.status !== "INTEGRATING") {
        throw new QueueProcessingFailure(
          "error",
          `task "${task.id}" is "${task.status}" while its integration queue entry is claimed`,
        );
      }
      const verificationResolution = resolveVerificationChecksForTask(
        task.definition.verification.required,
        this.verificationChecks,
      );
      if (!verificationResolution.ok) {
        throw new QueueProcessingFailure(
          "error",
          `no verification command configured for required checks: ${verificationResolution.missingChecks.join(", ")}`,
        );
      }

      await this.markIntegrationStageRunning(attempt.id);
      const worktreePath = join(
        this.worktreesDir,
        task.id,
        `attempt-${String(attempt.number)}`,
      );
      const reconciliation = await this.drift.reconcile({
        baseRevision: entry.baseRevision,
        taskRevision,
        worktreePath,
      });

      let integration: GitIntegrationResult;
      switch (reconciliation.kind) {
        case "failed":
        case "conflict":
        case "unsafe":
          throw new QueueProcessingFailure("error", reconciliation.detail);
        case "reconciled": {
          taskRevision = reconciliation.taskRevision;
          const postReconciliation = await this.drift.evaluate({
            baseRevision: reconciliation.integrationHead,
            taskRevision,
          });
          if (postReconciliation.status !== "CURRENT") {
            throw new QueueProcessingFailure(
              "error",
              `reconciled task revision ${taskRevision} is not current against integration HEAD ${reconciliation.integrationHead}: ${postReconciliation.detail}`,
            );
          }
          await this.runReconciliationVerification(
            task,
            entry,
            worktreePath,
            verificationResolution.checks,
            taskRevision,
          );
          integration = await this.integrate(entry, taskRevision);
          break;
        }
        case "current":
          integration = await this.integrate(entry, taskRevision);
          break;
        case "already-integrated":
          integration = {
            kind: "already-integrated",
            revision: reconciliation.integrationHead,
          };
          break;
      }

      await this.appendIntegrationCompleted(task.id, entry.attemptId, integration);
      await this.runIntegrationVerification(
        entry,
        verificationResolution.checks,
        integration.revision,
      );
      await this.settleSuccess(
        task,
        attempt,
        entry,
      );
      try {
        await this.releaseExecution(entry, "COMPLETED", undefined);
      } catch (error) {
        return {
          kind: "failed",
          entry,
          taskRevision,
          reason: `terminal integration settlement succeeded but execution lock release failed: ${describeError(error)}`,
          recoveryRequired: true,
        };
      }
      await this.cleanupSuccessfulWorktree(worktreePath);
      return {
        kind: "processed",
        entry,
        taskRevision,
        integration,
      };
    } catch (error) {
      const reason = describeError(error);
      const settlementIssue = await this.settleFailure(entry, taskRevision, error);
      return {
        kind: "failed",
        entry,
        taskRevision,
        reason:
          settlementIssue === undefined
            ? reason
            : `${reason}; queue settlement failed: ${settlementIssue}`,
        ...(settlementIssue === undefined
          ? {}
          : { recoveryRequired: true }),
      };
    }
  }

  private async integrate(
    entry: IntegrationQueueEntry,
    taskRevision: string,
  ): Promise<GitIntegrationResult> {
    if (taskRevision.length === 0) {
      throw new QueueProcessingFailure("error", "task revision is empty");
    }
    try {
      return await this.git.integrateBranch(this.projectRoot, entry.branch);
    } catch (error) {
      throw new QueueProcessingFailure(
        "error",
        `integration failed: ${describeError(error)}`,
      );
    }
  }

  private async runReconciliationVerification(
    task: Task,
    entry: IntegrationQueueEntry,
    worktreePath: string,
    checks: readonly VerificationCheckSpec[],
    taskRevision: string,
  ): Promise<void> {
    let run: VerificationRunResult;
    try {
      run = await this.verification.run({
        attemptId: entry.attemptId,
        cwd: worktreePath,
        checks,
      });
    } catch (error) {
      throw new QueueProcessingFailure(
        "verification_failed",
        `verification after reconciliation failed to run: ${describeError(error)}`,
      );
    }
    await this.store.appendEvents([
      verificationEvent(
        task.id,
        entry.attemptId,
        run,
        taskRevision,
        this.clock(),
      ),
    ]);
    if (run.cancelled) {
      throw new QueueProcessingFailure(
        "cancelled",
        "verification after reconciliation was cancelled",
      );
    }
    if (!run.passed) {
      throw new QueueProcessingFailure(
        "verification_failed",
        `verification after reconciliation failed: ${describeVerificationFailures(run)}`,
      );
    }
  }

  private async runIntegrationVerification(
    entry: IntegrationQueueEntry,
    checks: readonly VerificationCheckSpec[],
    revision: string,
  ): Promise<VerificationRunResult> {
    let run: VerificationRunResult;
    try {
      run = await this.verification.run({
        attemptId: entry.attemptId,
        cwd: this.projectRoot,
        checks,
      });
    } catch (error) {
      throw new QueueProcessingFailure(
        "verification_failed",
        `integration verification failed to run: ${describeError(error)}`,
      );
    }
    await this.store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.integrationVerificationCompleted,
        taskId: entry.taskId,
        payload: {
          attemptId: entry.attemptId,
          revision,
          status: run.status,
          checks: toVerificationResults(run),
        } satisfies IntegrationVerificationCompletedPayload,
        occurredAt: this.clock(),
      },
    ]);
    if (run.cancelled) {
      throw new QueueProcessingFailure(
        "cancelled",
        "integration verification was cancelled",
      );
    }
    if (!run.passed) {
      throw new QueueProcessingFailure(
        "verification_failed",
        `integration verification failed: ${describeVerificationFailures(run)}`,
      );
    }
    return run;
  }

  private async settleSuccess(
    task: Task,
    attempt: Attempt,
    entry: IntegrationQueueEntry,
  ): Promise<void> {
    assertTaskTransition(task.status, "DONE");
    const finishedAt = this.clock();
    const finishedAttempt: Attempt = {
      ...attempt,
      status: "SUCCEEDED",
      finishedAt,
    };
    await this.store.transaction(async () => {
      await this.finishIntegrationStage(entry.attemptId, "SUCCEEDED");
      await this.store.putAttempt(finishedAttempt);
      await this.store.setTaskStatus(task.id, "DONE", finishedAt);
      await this.store.completeIntegrationQueueEntry(entry.id, finishedAt);
      await this.store.appendEvents([
        {
          type: ORCHESTRATION_EVENTS.taskTransitioned,
          taskId: task.id,
          payload: {
            from: task.status,
            to: "DONE",
            attemptId: attempt.id,
          } satisfies TaskTransitionedPayload,
          occurredAt: finishedAt,
        },
      ]);
    });
  }

  private async settleFailure(
    entry: IntegrationQueueEntry,
    taskRevision: string,
    error: unknown,
  ): Promise<string | undefined> {
    const reason = describeError(error);
    const task = await this.store.getTask(entry.taskId);
    const attempt = await this.store.getAttempt(entry.attemptId);
    const finishedAt = this.clock();
    let settlementIssue: string | undefined;
    let settled = false;
    try {
      await this.store.transaction(async () => {
        if (attempt !== null) {
          const failure = failureFor(error);
          await this.finishIntegrationStage(entry.attemptId, "FAILED", {
            kind: "error",
            message: reason,
          });
          await this.store.putAttempt({
            ...attempt,
            status: failure.kind === "cancelled" ? "CANCELLED" : "FAILED",
            finishedAt,
            failure,
          });
        }
        const taskFailure = failureFor(error);
        const terminalTaskStatus =
          taskFailure.kind === "cancelled" ? "CANCELLED" : "FAILED";
        if (task !== null && task.status === "INTEGRATING") {
          await this.store.setTaskStatus(task.id, terminalTaskStatus, finishedAt);
          await this.store.appendEvents([
            {
              type: ORCHESTRATION_EVENTS.taskTransitioned,
              taskId: task.id,
              payload: {
                from: task.status,
                to: terminalTaskStatus,
                attemptId: entry.attemptId,
                failure: failureFor(error),
              } satisfies TaskTransitionedPayload,
              occurredAt: finishedAt,
            },
          ]);
        }
        await this.store.failIntegrationQueueEntry(
          entry.id,
          { message: `${reason} (task revision ${taskRevision})` },
          finishedAt,
        );
        settled = true;
      });
    } catch (settlementError) {
      settlementIssue = describeError(settlementError);
    }
    if (settled) {
      try {
        await this.releaseExecution(
          entry,
          failureFor(error).kind === "cancelled" ? "CANCELLED" : "FAILED",
          { message: reason },
        );
      } catch (releaseError) {
        settlementIssue =
          settlementIssue === undefined
            ? describeError(releaseError)
            : `${settlementIssue}; lock release failed: ${describeError(releaseError)}`;
      }
    }
    return settlementIssue;
  }

  private async releaseExecution(
    entry: IntegrationQueueEntry,
    status: "COMPLETED" | "FAILED" | "CANCELLED",
    failure: { readonly message: string } | undefined,
  ): Promise<void> {
    if (entry.executionId !== undefined) {
      await this.store.releaseTaskExecution(
        entry.executionId,
        status,
        this.clock(),
        failure,
      );
      return;
    }
    await this.store.releaseResourceLocks({
      taskId: entry.taskId,
      attemptId: entry.attemptId,
    });
  }

  private async markIntegrationStageRunning(attemptId: string): Promise<void> {
    const stage = await this.integrationStage(attemptId);
    if (stage === undefined || stage.status === "RUNNING") {
      return;
    }
    await this.store.putStageRun({ ...stage, status: "RUNNING" });
  }

  private async finishIntegrationStage(
    attemptId: string,
    status: "SUCCEEDED" | "FAILED",
    failure?: { readonly kind: "error"; readonly message: string },
  ): Promise<void> {
    const stage = await this.integrationStage(attemptId);
    if (stage === undefined) {
      return;
    }
    const finishedAt = this.clock();
    await this.store.putStageRun({
      ...stage,
      status,
      finishedAt,
      ...(failure === undefined ? {} : { failure }),
    });
  }

  private async integrationStage(attemptId: string): Promise<StageRun | undefined> {
    const stages = await this.store.listStageRuns(attemptId);
    return stages.find((stage) => stage.stage === "INTEGRATE");
  }

  private async cleanupSuccessfulWorktree(worktreePath: string): Promise<void> {
    try {
      if (!(await this.git.worktreeExists(this.projectRoot, worktreePath))) {
        return;
      }
      if (!(await this.git.status(worktreePath)).clean) {
        return;
      }
      await this.git.removeWorktree(this.projectRoot, worktreePath);
    } catch {
      // Cleanup is observable through the remaining worktree and durable DONE
      // state; it must not turn a verified integration into a failed task.
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (task === null) {
      throw new QueueProcessingFailure("error", `task "${taskId}" not found`);
    }
    return task;
  }

  private async requireAttempt(attemptId: string): Promise<Attempt> {
    const attempt = await this.store.getAttempt(attemptId);
    if (attempt === null) {
      throw new QueueProcessingFailure(
        "error",
        `attempt "${attemptId}" not found`,
      );
    }
    return attempt;
  }

  private async appendIntegrationCompleted(
    taskId: string,
    attemptId: string,
    integration: GitIntegrationResult,
  ): Promise<void> {
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
  }
}

function verificationEvent(
  taskId: string,
  attemptId: string,
  run: VerificationRunResult,
  revision: string,
  occurredAt: IsoTimestamp,
): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.verificationCompleted,
    taskId,
    payload: {
      attemptId,
      revision,
      status: run.status,
      checks: toVerificationResults(run),
    } satisfies VerificationCompletedPayload,
    occurredAt,
  };
}

function failureFor(error: unknown): AttemptFailure {
  if (error instanceof QueueProcessingFailure) {
    return { kind: error.kind, message: error.message };
  }
  return { kind: "error", message: describeError(error) };
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
