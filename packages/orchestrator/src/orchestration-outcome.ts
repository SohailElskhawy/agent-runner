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
