import type {
  Attempt,
  AttemptId,
  Task,
  TaskId,
  TaskStatus,
} from "@agentic-dev-runner/core";
import type { GitIntegrationResult } from "@agentic-dev-runner/git";

export type WorktreeCleanupOutcome =
  | { readonly kind: "removed" }
  | {
      readonly kind: "skipped";
      readonly reason: "dirty-worktree" | "status-unavailable";
    }
  | { readonly kind: "failed"; readonly message: string };

export type PendingIntegrationTaskRun = {
  readonly kind: "pending-integration";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly branch: string;
  readonly worktreePath: string;
  readonly taskRevision: string;
};

export type CompletedTaskRun = {
  readonly kind: "completed";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly branch: string;
  readonly worktreePath: string;
  readonly integration: GitIntegrationResult;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type FailedTaskRun = {
  readonly kind: "failed";
  readonly taskId: TaskId;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly reason: string;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type CancelledTaskRun = {
  readonly kind: "cancelled";
  readonly taskId: TaskId;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly reason: string;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type RejectedTaskRun = {
  readonly kind: "rejected";
  readonly taskId: TaskId;
  readonly reason: string;
  readonly taskStatus?: TaskStatus | undefined;
};

export type SingleTaskRunOutcome =
  | CompletedTaskRun
  | FailedTaskRun
  | CancelledTaskRun
  | RejectedTaskRun;

export type NoOpRecovery = {
  readonly kind: "no-op";
  readonly taskId: TaskId;
  readonly detail: string;
};

export type CompletedRecovery = {
  readonly kind: "completed";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly integration: GitIntegrationResult;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type SafeToRetryRecovery = {
  readonly kind: "safe-to-retry";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly detail: string;
};

export type RequiresReconciliationRecovery = {
  readonly kind: "requires-reconciliation";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly detail: string;
};

export type RequiresHumanRecovery = {
  readonly kind: "requires-human";
  readonly taskId: TaskId;
  readonly attemptId?: AttemptId | undefined;
  readonly task: Task;
  readonly detail: string;
};

export type FailedRecovery = {
  readonly kind: "failed";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly reason: string;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type CancelledRecovery = {
  readonly kind: "cancelled";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly task: Task;
  readonly reason: string;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type RecoveryOutcome =
  | NoOpRecovery
  | CompletedRecovery
  | SafeToRetryRecovery
  | RequiresReconciliationRecovery
  | RequiresHumanRecovery
  | FailedRecovery
  | CancelledRecovery;
