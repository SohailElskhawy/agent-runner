import { join } from "node:path";
import type {
  Attempt,
  AttemptFailure,
  IsoTimestamp,
  Task,
  TaskId,
  TaskStatus,
} from "@agentic-dev-runner/core";
import { assertReconcileTaskStatus } from "@agentic-dev-runner/core";
import type { GitIntegrationResult, GitManager } from "@agentic-dev-runner/git";
import type { NewEvent, RunnerStore } from "@agentic-dev-runner/persistence";
import type {
  VerificationCheckSpec,
  VerificationEngine,
  VerificationRunResult,
} from "@agentic-dev-runner/verification";
import { toVerificationResults } from "@agentic-dev-runner/verification";
import { OrchestrationError } from "./orchestration-error.js";
import {
  ORCHESTRATION_EVENTS,
  type CommitCreatedPayload,
  type IntegrationCompletedPayload,
  type RecoveryOutcomeKind,
  type RecoveryReconciledPayload,
  type TaskTransitionedPayload,
  type VerificationCompletedPayload,
  type WorktreeCleanupFailedPayload,
} from "./orchestration-events.js";
import type {
  RecoveryOutcome,
  WorktreeCleanupOutcome,
} from "./orchestration-outcome.js";

export const RECOVERY_ACTIVE_STATUSES = [
  "IMPLEMENTING",
  "VERIFYING",
  "INTEGRATING",
] as const;

export type RecoveryActiveStatus = (typeof RECOVERY_ACTIVE_STATUSES)[number];

export type CrashRecoveryOptions = {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly verification: VerificationEngine;
  readonly verificationChecks: readonly VerificationCheckSpec[];
  readonly projectRoot: string;
  readonly worktreesDir: string;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export interface CrashRecovery {
  reconcileTask(taskId: TaskId): Promise<RecoveryOutcome>;
  reconcileUnfinished(): Promise<RecoveryOutcome[]>;
}

export function createCrashRecovery(
  options: CrashRecoveryOptions,
): CrashRecovery {
  return new SequentialCrashRecovery(options);
}

type WorktreeInspection =
  | { readonly kind: "missing" }
  | {
      readonly kind: "available";
      readonly clean: boolean;
      readonly headRevision: string;
      readonly changedPaths: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason: string };

class SequentialCrashRecovery implements CrashRecovery {
  private readonly store: RunnerStore;
  private readonly git: GitManager;
  private readonly verification: VerificationEngine;
  private readonly verificationChecks: readonly VerificationCheckSpec[];
  private readonly projectRoot: string;
  private readonly worktreesDir: string;
  private readonly signal: AbortSignal | undefined;
  private readonly clock: () => IsoTimestamp;

  constructor(options: CrashRecoveryOptions) {
    validateOptions(options);
    this.store = options.store;
    this.git = options.git;
    this.verification = options.verification;
    this.verificationChecks = [...options.verificationChecks];
    this.projectRoot = options.projectRoot;
    this.worktreesDir = options.worktreesDir;
    this.signal = options.signal;
    this.clock = options.now ?? defaultClock;
  }

  async reconcileUnfinished(): Promise<RecoveryOutcome[]> {
    const tasks = await this.store.listTasks();
    const outcomes: RecoveryOutcome[] = [];
    for (const task of tasks) {
      if (!isRecoveryEligibleStatus(task.status)) {
        continue;
      }
      outcomes.push(await this.reconcileTask(task.id));
    }
    return outcomes;
  }

  async reconcileTask(taskId: TaskId): Promise<RecoveryOutcome> {
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return noOp(taskId, `task "${taskId}" does not exist`);
    }
    if (task.status === "FAILED") {
      return await this.reconcileFailedTask(task);
    }
    if (!isRecoveryActiveStatus(task.status)) {
      return noOp(
        taskId,
        `task "${taskId}" is "${task.status}" and needs no recovery`,
      );
    }
    const attempts = await this.store.listAttempts({ taskId });
    const attempt = attempts.at(-1);
    if (attempt === undefined) {
      return await this.requiresHuman(
        task,
        undefined,
        `task "${taskId}" is "${task.status}" but has no attempt; the persisted execution state is incomplete`,
      );
    }
    if (attempt.status !== "RUNNING") {
      return await this.requiresHuman(
        task,
        attempt,
        `attempt "${attempt.id}" is "${attempt.status}" while the task is "${task.status}"; the persisted execution state is inconsistent`,
      );
    }
    switch (task.status) {
      case "IMPLEMENTING":
        return await this.reconcileImplementing(task, attempt);
      case "VERIFYING":
        return await this.reconcileVerifying(task, attempt);
      case "INTEGRATING":
        return await this.reconcileIntegrating(task, attempt);
    }
  }

  private async reconcileImplementing(
    task: Task,
    attempt: Attempt,
  ): Promise<RecoveryOutcome> {
    const worktreePath = taskWorktreePath(
      this.worktreesDir,
      task.id,
      attempt.number,
    );
    const inspection = await this.inspectTaskWorktree(worktreePath);
    if (inspection.kind === "missing") {
      return await this.resetForRetry(
        task,
        attempt,
        `task worktree "${worktreePath}" does not exist, so no agent output exists to preserve or duplicate`,
      );
    }
    if (inspection.kind === "unavailable") {
      return await this.requiresHuman(
        task,
        attempt,
        `could not inspect the task worktree: ${inspection.reason}`,
      );
    }
    if (inspection.headRevision !== attempt.baseRevision) {
      return await this.requiresHuman(
        task,
        attempt,
        `task worktree "${worktreePath}" contains unexpected commits (HEAD ${inspection.headRevision} differs from the attempt base revision ${attempt.baseRevision})`,
      );
    }
    if (!inspection.clean) {
      return await this.requiresReconciliation(
        task,
        attempt,
        `uncommitted agent changes (${inspection.changedPaths.join(", ") || "unknown paths"}) are preserved in "${worktreePath}"; a human must decide whether to keep, salvage, or discard them`,
      );
    }
    return await this.resetForRetry(
      task,
      attempt,
      `task worktree "${worktreePath}" is clean at the attempt base revision, so no agent output exists to duplicate`,
    );
  }

  private async reconcileVerifying(
    task: Task,
    attempt: Attempt,
  ): Promise<RecoveryOutcome> {
    const branch = taskBranch(task.id, attempt.number);
    const worktreePath = taskWorktreePath(
      this.worktreesDir,
      task.id,
      attempt.number,
    );
    const inspection = await this.inspectTaskWorktree(worktreePath);
    if (inspection.kind !== "available") {
      const detail =
        inspection.kind === "missing"
          ? `task worktree "${worktreePath}" does not exist, so verification evidence cannot be produced`
          : `could not inspect the task worktree: ${inspection.reason}`;
      return await this.requiresHuman(task, attempt, detail);
    }
    if (inspection.headRevision !== attempt.baseRevision) {
      return await this.requiresHuman(
        task,
        attempt,
        `task worktree "${worktreePath}" contains unexpected commits (HEAD ${inspection.headRevision} differs from the attempt base revision ${attempt.baseRevision})`,
      );
    }
    const recorded = await this.latestVerificationEvidence(task.id, attempt.id);
    if (recorded !== undefined) {
      return await this.applyRecordedVerification(
        task,
        attempt,
        branch,
        worktreePath,
        recorded,
      );
    }
    const missingChecks = listMissingVerificationChecks(
      task,
      this.verificationChecks,
    );
    if (missingChecks.length > 0) {
      return await this.requiresHuman(
        task,
        attempt,
        `no verification command is configured for required checks: ${missingChecks.join(", ")}, so verification evidence cannot be produced`,
      );
    }
    let run: VerificationRunResult;
    try {
      run = await this.verification.run({
        attemptId: attempt.id,
        cwd: worktreePath,
        checks: selectVerificationChecks(task, this.verificationChecks),
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (error) {
      return await this.finishFailed(
        task,
        attempt,
        worktreePath,
        "error",
        `verification rerun failed during recovery: ${describeError(error)}`,
      );
    }
    await this.store.appendEvents([
      verificationCompletedEvent(task.id, attempt.id, run, this.clock()),
    ]);
    if (run.cancelled) {
      return await this.finishFailed(
        task,
        attempt,
        worktreePath,
        "cancelled",
        "verification rerun was cancelled during recovery",
      );
    }
    if (!run.passed) {
      return await this.finishFailed(
        task,
        attempt,
        worktreePath,
        "verification_failed",
        `verification rerun failed: ${describeVerificationFailures(run)}`,
      );
    }
    return await this.completeIntegrationFromVerification(
      task,
      attempt,
      branch,
      worktreePath,
    );
  }

  private async applyRecordedVerification(
    task: Task,
    attempt: Attempt,
    branch: string,
    worktreePath: string,
    recorded: VerificationCompletedPayload,
  ): Promise<RecoveryOutcome> {
    if (recorded.status === "PASSED") {
      return await this.completeIntegrationFromVerification(
        task,
        attempt,
        branch,
        worktreePath,
      );
    }
    if (recorded.status === "FAILED") {
      return await this.finishFailed(
        task,
        attempt,
        worktreePath,
        "verification_failed",
        "recorded verification evidence shows failure before the runner was interrupted",
      );
    }
    return await this.finishFailed(
      task,
      attempt,
      worktreePath,
      "cancelled",
      "recorded verification evidence shows cancellation before the runner was interrupted",
    );
  }

  private async reconcileIntegrating(
    task: Task,
    attempt: Attempt,
  ): Promise<RecoveryOutcome> {
    const branch = taskBranch(task.id, attempt.number);
    const worktreePath = taskWorktreePath(
      this.worktreesDir,
      task.id,
      attempt.number,
    );
    const commitEvidence = await this.latestCommitEvidence(task.id, attempt.id);
    if (commitEvidence === undefined) {
      return await this.requiresHuman(
        task,
        attempt,
        `task "${task.id}" is INTEGRATING but no committed task revision is recorded for attempt "${attempt.id}"`,
      );
    }
    return await this.reconcileIntegration(
      task,
      attempt,
      branch,
      worktreePath,
      commitEvidence.revision,
      task.status,
    );
  }

  private async reconcileFailedTask(
    task: Task,
  ): Promise<RecoveryOutcome> {
    const attempts = await this.store.listAttempts({ taskId: task.id });
    const attempt = attempts.at(-1);
    if (attempt === undefined) {
      return noOp(
        task.id,
        `task "${task.id}" is FAILED without attempts; there is no integration evidence to reconcile`,
      );
    }
    if (attempt.status === "RUNNING") {
      return noOp(
        task.id,
        `task "${task.id}" is FAILED while attempt "${attempt.id}" is RUNNING; the persisted execution state is inconsistent`,
      );
    }
    const commitEvidence = await this.latestCommitEvidence(task.id, attempt.id);
    if (commitEvidence === undefined) {
      return noOp(
        task.id,
        `task "${task.id}" is FAILED without committed task revision evidence for attempt "${attempt.id}"; there is no integration to reconcile`,
      );
    }
    let headRevision: string;
    try {
      headRevision = await this.git.resolveHeadRevision(this.projectRoot);
    } catch (error) {
      return noOp(
        task.id,
        `task "${task.id}" is FAILED and integration state is unavailable (${describeError(error)}); the FAILED status is kept until Git evidence is available`,
      );
    }
    let integrated: boolean;
    try {
      integrated = await this.git.isAncestor(
        this.projectRoot,
        commitEvidence.revision,
        headRevision,
      );
    } catch (error) {
      return noOp(
        task.id,
        `task "${task.id}" is FAILED and integration state is unavailable (${describeError(error)}); the FAILED status is kept until Git evidence is available`,
      );
    }
    if (!integrated) {
      return noOp(
        task.id,
        `task "${task.id}" is FAILED and its recorded task commit ${commitEvidence.revision} is not integrated; the FAILED status reflects an observed integration failure`,
      );
    }
    return await this.finishIntegrated(
      task,
      attempt,
      taskWorktreePath(this.worktreesDir, task.id, attempt.number),
      commitEvidence.revision,
      { kind: "already-integrated", revision: commitEvidence.revision },
      `task commit ${commitEvidence.revision} was already integrated before the runner restarted despite the persisted FAILED status; the task converged to DONE without integrating again`,
      task.status,
    );
  }

  private async reconcileIntegration(
    task: Task,
    attempt: Attempt,
    branch: string,
    worktreePath: string,
    commitRevision: string,
    fromStatus: TaskStatus,
  ): Promise<RecoveryOutcome> {
    let headRevision: string;
    try {
      headRevision = await this.git.resolveHeadRevision(this.projectRoot);
    } catch (error) {
      return await this.requiresHuman(
        task,
        attempt,
        `integration repository state is unavailable: ${describeError(error)}`,
      );
    }
    let integrated: boolean;
    try {
      integrated = await this.git.isAncestor(
        this.projectRoot,
        commitRevision,
        headRevision,
      );
    } catch (error) {
      return await this.requiresHuman(
        task,
        attempt,
        `integration repository state is unavailable: ${describeError(error)}`,
      );
    }
    if (integrated) {
      return await this.finishIntegrated(
        task,
        attempt,
        worktreePath,
        commitRevision,
        { kind: "already-integrated", revision: commitRevision },
        `task commit ${commitRevision} was already integrated before the runner restarted; integration was not performed again`,
        fromStatus,
      );
    }
    let branchExists: boolean;
    try {
      branchExists = await this.git.branchExists(this.projectRoot, branch);
    } catch (error) {
      return await this.requiresHuman(
        task,
        attempt,
        `task branch state is unavailable: ${describeError(error)}`,
      );
    }
    if (!branchExists) {
      return await this.requiresHuman(
        task,
        attempt,
        `task branch "${branch}" no longer exists, so integration state cannot be determined for the recorded task commit ${commitRevision}`,
      );
    }
    let branchTip: string;
    try {
      branchTip = await this.git.resolveBranchRevision(this.projectRoot, branch);
    } catch (error) {
      return await this.requiresHuman(
        task,
        attempt,
        `task branch state is unavailable: ${describeError(error)}`,
      );
    }
    if (branchTip !== commitRevision) {
      return await this.requiresHuman(
        task,
        attempt,
        `task branch "${branch}" points at ${branchTip} instead of the recorded task commit ${commitRevision}`,
      );
    }
    let fastForwardable: boolean;
    try {
      fastForwardable = await this.git.isAncestor(
        this.projectRoot,
        headRevision,
        commitRevision,
      );
    } catch (error) {
      return await this.requiresHuman(
        task,
        attempt,
        `integration repository state is unavailable: ${describeError(error)}`,
      );
    }
    if (!fastForwardable) {
      return await this.requiresHuman(
        task,
        attempt,
        `integration branch HEAD (${headRevision}) and the task commit (${commitRevision}) have diverged; a human must decide how integration should proceed`,
      );
    }
    try {
      const integration = await this.git.integrateBranch(
        this.projectRoot,
        branch,
      );
      return await this.finishIntegrated(
        task,
        attempt,
        worktreePath,
        commitRevision,
        integration,
        `integration was retried after the interruption and task commit ${commitRevision} is now integrated`,
        fromStatus,
      );
    } catch (error) {
      return await this.finishFailed(
        task,
        attempt,
        worktreePath,
        "error",
        `integration retry failed: ${describeError(error)}`,
      );
    }
  }

  private async completeIntegrationFromVerification(
    task: Task,
    attempt: Attempt,
    branch: string,
    worktreePath: string,
  ): Promise<RecoveryOutcome> {
    const commitMessage = `task ${task.id}: ${task.title}`;
    let commitRevision: string;
    try {
      commitRevision = await this.git.commitStaged(worktreePath, commitMessage);
    } catch (error) {
      return await this.finishFailed(
        task,
        attempt,
        worktreePath,
        "error",
        `failed to commit the verified task changes: ${describeError(error)}`,
      );
    }
    await this.transitionWithEvents(
      task.id,
      task.status,
      "INTEGRATING",
      attempt.id,
      [
        {
          type: ORCHESTRATION_EVENTS.commitCreated,
          taskId: task.id,
          payload: {
            attemptId: attempt.id,
            revision: commitRevision,
            message: commitMessage,
          } satisfies CommitCreatedPayload,
          occurredAt: this.clock(),
        },
      ],
    );
    return await this.reconcileIntegration(
      task,
      attempt,
      branch,
      worktreePath,
      commitRevision,
      "INTEGRATING",
    );
  }

  private async resetForRetry(
    task: Task,
    attempt: Attempt,
    detail: string,
  ): Promise<RecoveryOutcome> {
    const worktreePath = taskWorktreePath(
      this.worktreesDir,
      task.id,
      attempt.number,
    );
    const occurredAt = this.clock();
    const interruptedAttempt = interruptedAttemptOf(
      attempt,
      { kind: "error", message: `runner was interrupted during "${task.status}"; attempt did not complete (${detail})` },
      occurredAt,
    );
    assertReconcileTaskStatus(task.status, "BLOCKED");
    assertReconcileTaskStatus("BLOCKED", "READY");
    await this.store.transaction(async () => {
      await this.store.putAttempt(interruptedAttempt);
      await this.store.setTaskStatus(task.id, "BLOCKED", occurredAt);
      await this.store.setTaskStatus(task.id, "READY", occurredAt);
      await this.store.appendEvents([
        recoveryEvent(
          task.id,
          attempt.id,
          task.status,
          "safe-to-retry",
          detail,
          occurredAt,
        ),
        transitionEvent(task.id, attempt.id, task.status, "BLOCKED", occurredAt),
        transitionEvent(task.id, attempt.id, "BLOCKED", "READY", occurredAt),
      ]);
    });
    const cleanup = await this.removeAbandonedWorktree(
      task.id,
      attempt.id,
      worktreePath,
    );
    const refreshed = await this.requireTask(task.id);
    return {
      kind: "safe-to-retry",
      taskId: task.id,
      attemptId: attempt.id,
      task: refreshed,
      detail,
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  }

  private async requiresReconciliation(
    task: Task,
    attempt: Attempt,
    detail: string,
  ): Promise<RecoveryOutcome> {
    const occurredAt = this.clock();
    const interruptedAttempt = interruptedAttemptOf(
      attempt,
      {
        kind: "error",
        message: `runner was interrupted during "${task.status}"; uncommitted work was preserved (${detail})`,
      },
      occurredAt,
    );
    assertReconcileTaskStatus(task.status, "BLOCKED");
    await this.store.transaction(async () => {
      await this.store.putAttempt(interruptedAttempt);
      await this.store.setTaskStatus(task.id, "BLOCKED", occurredAt);
      await this.store.appendEvents([
        recoveryEvent(
          task.id,
          attempt.id,
          task.status,
          "requires-reconciliation",
          detail,
          occurredAt,
        ),
        transitionEvent(task.id, attempt.id, task.status, "BLOCKED", occurredAt),
      ]);
    });
    const refreshed = await this.requireTask(task.id);
    return {
      kind: "requires-reconciliation",
      taskId: task.id,
      attemptId: attempt.id,
      task: refreshed,
      detail,
    };
  }

  private async requiresHuman(
    task: Task,
    attempt: Attempt | undefined,
    detail: string,
  ): Promise<RecoveryOutcome> {
    const occurredAt = this.clock();
    assertReconcileTaskStatus(task.status, "NEEDS_HUMAN");
    await this.store.transaction(async () => {
      if (attempt !== undefined) {
        await this.store.putAttempt(
          interruptedAttemptOf(
            attempt,
            {
              kind: "error",
              message: `runner was interrupted during "${task.status}"; human intervention is required (${detail})`,
            },
            occurredAt,
          ),
        );
      }
      await this.store.setTaskStatus(task.id, "NEEDS_HUMAN", occurredAt);
      await this.store.appendEvents([
        recoveryEvent(
          task.id,
          attempt?.id,
          task.status,
          "requires-human",
          detail,
          occurredAt,
        ),
        transitionEvent(
          task.id,
          attempt?.id,
          task.status,
          "NEEDS_HUMAN",
          occurredAt,
        ),
      ]);
    });
    const refreshed = await this.requireTask(task.id);
    return {
      kind: "requires-human",
      taskId: task.id,
      ...(attempt === undefined ? {} : { attemptId: attempt.id }),
      task: refreshed,
      detail,
    };
  }

  private async finishIntegrated(
    task: Task,
    attempt: Attempt,
    worktreePath: string,
    commitRevision: string,
    integration: GitIntegrationResult,
    detail: string,
    fromStatus: TaskStatus,
  ): Promise<RecoveryOutcome> {
    const occurredAt = this.clock();
    const succeededAttempt = succeededAttemptOf(attempt, occurredAt);
    assertReconcileTaskStatus(fromStatus, "DONE");
    await this.store.transaction(async () => {
      await this.store.putAttempt(succeededAttempt);
      await this.store.setTaskStatus(task.id, "DONE", occurredAt);
      const recordedIntegration = await this.latestIntegrationEvidence(
        task.id,
        attempt.id,
      );
      await this.store.appendEvents([
        ...(recordedIntegration === undefined
          ? [
              {
                type: ORCHESTRATION_EVENTS.integrationCompleted,
                taskId: task.id,
                payload: {
                  attemptId: attempt.id,
                  revision: integration.revision,
                  kind: integration.kind,
                } satisfies IntegrationCompletedPayload,
                occurredAt,
              },
            ]
          : []),
        recoveryEvent(
          task.id,
          attempt.id,
          fromStatus,
          "completed",
          detail,
          occurredAt,
          commitRevision,
        ),
        transitionEvent(task.id, attempt.id, fromStatus, "DONE", occurredAt),
      ]);
    });
    const cleanup = await this.cleanupWorktree(task.id, attempt.id, worktreePath);
    const refreshed = await this.requireTask(task.id);
    return {
      kind: "completed",
      taskId: task.id,
      attemptId: attempt.id,
      task: refreshed,
      integration,
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  }

  private async finishFailed(
    task: Task,
    attempt: Attempt,
    worktreePath: string,
    failureKind: AttemptFailure["kind"],
    reason: string,
  ): Promise<RecoveryOutcome> {
    const targetStatus: TaskStatus =
      failureKind === "cancelled" ? "CANCELLED" : "FAILED";
    const outcomeKind: RecoveryOutcomeKind =
      failureKind === "cancelled" ? "cancelled" : "failed";
    const occurredAt = this.clock();
    const finishedAttempt = interruptedAttemptOf(
      attempt,
      { kind: failureKind, message: reason },
      occurredAt,
    );
    assertReconcileTaskStatus(task.status, targetStatus);
    await this.store.transaction(async () => {
      await this.store.putAttempt(finishedAttempt);
      await this.store.setTaskStatus(task.id, targetStatus, occurredAt);
      await this.store.appendEvents([
        recoveryEvent(
          task.id,
          attempt.id,
          task.status,
          outcomeKind,
          reason,
          occurredAt,
        ),
        transitionEvent(
          task.id,
          attempt.id,
          task.status,
          targetStatus,
          occurredAt,
          { kind: failureKind, message: reason },
        ),
      ]);
    });
    const cleanup = await this.cleanupWorktree(task.id, attempt.id, worktreePath);
    const refreshed = await this.requireTask(task.id);
    return {
      kind: outcomeKind,
      taskId: task.id,
      attemptId: attempt.id,
      task: refreshed,
      reason,
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  }

  private async transitionWithEvents(
    taskId: TaskId,
    from: TaskStatus,
    to: TaskStatus,
    attemptId: string,
    evidenceEvents: readonly NewEvent[],
  ): Promise<void> {
    assertReconcileTaskStatus(from, to);
    const occurredAt = this.clock();
    await this.store.transaction(async () => {
      await this.store.setTaskStatus(taskId, to, occurredAt);
      await this.store.appendEvents([
        ...evidenceEvents,
        transitionEvent(taskId, attemptId, from, to, occurredAt),
      ]);
    });
  }

  private async removeAbandonedWorktree(
    taskId: TaskId,
    attemptId: string,
    worktreePath: string,
  ): Promise<WorktreeCleanupOutcome | undefined> {
    let exists: boolean;
    try {
      exists = await this.git.worktreeExists(this.projectRoot, worktreePath);
    } catch {
      return undefined;
    }
    if (!exists) {
      return undefined;
    }
    try {
      await this.git.removeWorktree(this.projectRoot, worktreePath);
      return { kind: "removed" };
    } catch (error) {
      return await reportCleanupFailure(
        this.store,
        taskId,
        attemptId,
        worktreePath,
        describeError(error),
        this.clock(),
      );
    }
  }

  private async cleanupWorktree(
    taskId: TaskId,
    attemptId: string,
    worktreePath: string,
  ): Promise<WorktreeCleanupOutcome | undefined> {
    let exists: boolean;
    try {
      exists = await this.git.worktreeExists(this.projectRoot, worktreePath);
    } catch {
      return undefined;
    }
    if (!exists) {
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
      return await reportCleanupFailure(
        this.store,
        taskId,
        attemptId,
        worktreePath,
        describeError(error),
        this.clock(),
      );
    }
  }

  private async inspectTaskWorktree(
    worktreePath: string,
  ): Promise<WorktreeInspection> {
    let exists: boolean;
    try {
      exists = await this.git.worktreeExists(this.projectRoot, worktreePath);
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
    if (!exists) {
      return { kind: "missing" };
    }
    let headRevision: string;
    try {
      headRevision = await this.git.resolveHeadRevision(worktreePath);
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
    let status;
    try {
      status = await this.git.status(worktreePath);
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
    return {
      kind: "available",
      clean: status.clean,
      headRevision,
      changedPaths: status.entries.map((entry) => entry.path),
    };
  }

  private async latestVerificationEvidence(
    taskId: TaskId,
    attemptId: string,
  ): Promise<VerificationCompletedPayload | undefined> {
    const events = await this.store.listEvents({
      taskId,
      type: ORCHESTRATION_EVENTS.verificationCompleted,
    });
    return latestPayloadOf(events, attemptId) as
      | VerificationCompletedPayload
      | undefined;
  }

  private async latestCommitEvidence(
    taskId: TaskId,
    attemptId: string,
  ): Promise<CommitCreatedPayload | undefined> {
    const events = await this.store.listEvents({
      taskId,
      type: ORCHESTRATION_EVENTS.commitCreated,
    });
    return latestPayloadOf(events, attemptId) as
      | CommitCreatedPayload
      | undefined;
  }

  private async latestIntegrationEvidence(
    taskId: TaskId,
    attemptId: string,
  ): Promise<IntegrationCompletedPayload | undefined> {
    const events = await this.store.listEvents({
      taskId,
      type: ORCHESTRATION_EVENTS.integrationCompleted,
    });
    return latestPayloadOf(events, attemptId) as
      | IntegrationCompletedPayload
      | undefined;
  }

  private async requireTask(taskId: TaskId): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (task === null) {
      throw new OrchestrationError(`task "${taskId}" is missing from the store`);
    }
    return task;
  }
}

function latestPayloadOf(
  events: readonly { readonly payload: unknown }[],
  attemptId: string,
): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { attemptId?: unknown }).attemptId === attemptId
    ) {
      return payload;
    }
  }
  return undefined;
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

function interruptedAttemptOf(
  attempt: Attempt,
  failure: AttemptFailure,
  finishedAt: IsoTimestamp,
): Attempt {
  return {
    ...attempt,
    status: attemptStatusForFailure(failure.kind),
    finishedAt,
    failure,
  };
}

function recoveryEvent(
  taskId: TaskId,
  attemptId: string | undefined,
  fromStatus: TaskStatus,
  outcome: RecoveryOutcomeKind,
  detail: string,
  occurredAt: IsoTimestamp,
  revision?: string,
): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.recoveryReconciled,
    taskId,
    payload: {
      ...(attemptId === undefined ? {} : { attemptId }),
      fromStatus,
      outcome,
      detail,
      ...(revision === undefined ? {} : { revision }),
    } satisfies RecoveryReconciledPayload,
    occurredAt,
  };
}

function transitionEvent(
  taskId: TaskId,
  attemptId: string | undefined,
  from: TaskStatus,
  to: TaskStatus,
  occurredAt: IsoTimestamp,
  failure?: Pick<AttemptFailure, "kind" | "message">,
): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.taskTransitioned,
    taskId,
    payload: {
      from,
      to,
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(failure === undefined ? {} : { failure }),
    } satisfies TaskTransitionedPayload,
    occurredAt,
  };
}

function verificationCompletedEvent(
  taskId: TaskId,
  attemptId: string,
  run: VerificationRunResult,
  occurredAt: IsoTimestamp,
): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.verificationCompleted,
    taskId,
    payload: {
      attemptId,
      status: run.status,
      checks: toVerificationResults(run),
    } satisfies VerificationCompletedPayload,
    occurredAt,
  };
}

async function reportCleanupFailure(
  store: RunnerStore,
  taskId: TaskId,
  attemptId: string,
  worktreePath: string,
  reason: string,
  occurredAt: IsoTimestamp,
): Promise<WorktreeCleanupOutcome> {
  try {
    await store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.worktreeCleanupFailed,
        taskId,
        payload: {
          attemptId,
          worktreePath,
          reason,
        } satisfies WorktreeCleanupFailedPayload,
        occurredAt,
      },
    ]);
  } catch {
    return { kind: "failed", message: reason };
  }
  return { kind: "failed", message: reason };
}

function noOp(taskId: TaskId, detail: string): RecoveryOutcome {
  return { kind: "no-op", taskId, detail };
}

function taskBranch(taskId: TaskId, attemptNumber: number): string {
  return `task/${taskId}/attempt-${String(attemptNumber)}`;
}

function taskWorktreePath(
  worktreesDir: string,
  taskId: TaskId,
  attemptNumber: number,
): string {
  return join(worktreesDir, taskId, `attempt-${String(attemptNumber)}`);
}

function isRecoveryActiveStatus(
  status: TaskStatus,
): status is RecoveryActiveStatus {
  return (RECOVERY_ACTIVE_STATUSES as readonly string[]).includes(status);
}

function isRecoveryEligibleStatus(status: TaskStatus): boolean {
  return isRecoveryActiveStatus(status) || status === "FAILED";
}

function succeededAttemptOf(
  attempt: Attempt,
  finishedAt: IsoTimestamp,
): Attempt {
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    number: attempt.number,
    status: "SUCCEEDED",
    agent: attempt.agent,
    ...(attempt.model === undefined ? {} : { model: attempt.model }),
    baseRevision: attempt.baseRevision,
    ...(attempt.contextManifest === undefined
      ? {}
      : { contextManifest: attempt.contextManifest }),
    ...(attempt.logs === undefined ? {} : { logs: attempt.logs }),
    ...(attempt.tokenUsage === undefined
      ? {}
      : { tokenUsage: attempt.tokenUsage }),
    ...(attempt.cost === undefined ? {} : { cost: attempt.cost }),
    startedAt: attempt.startedAt,
    finishedAt,
  };
}

function selectVerificationChecks(
  task: Task,
  configured: readonly VerificationCheckSpec[],
): VerificationCheckSpec[] {
  const required = task.definition.verification.required;
  return configured.filter((check) => required.includes(check.name));
}

function listMissingVerificationChecks(
  task: Task,
  configured: readonly VerificationCheckSpec[],
): string[] {
  return task.definition.verification.required.filter(
    (name) => !configured.some((check) => check.name === name),
  );
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

function validateOptions(options: CrashRecoveryOptions): void {
  if (options.projectRoot.length === 0) {
    throw new OrchestrationError("projectRoot must be a non-empty string");
  }
  if (options.worktreesDir.length === 0) {
    throw new OrchestrationError("worktreesDir must be a non-empty string");
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
