/**
 * Outcomes of the resolved workflow lifecycle execution.
 *
 * Extends the vertical-slice single-task outcomes with the explicit
 * `blocked` terminal outcome produced by review-cycle exhaustion: the task
 * is persisted as BLOCKED (unblockable back to READY by a human decision)
 * while every other failed gate keeps the existing `failed` outcome
 * semantics. Run outcomes stay runner-owned; agents never choose them.
 */

import type { Attempt, Task, TaskId } from "@agentic-dev-runner/core";
import type {
  CancelledTaskRun,
  CompletedTaskRun,
  FailedTaskRun,
  PendingIntegrationTaskRun,
  RejectedTaskRun,
  WorktreeCleanupOutcome,
} from "./orchestration-outcome.js";

export type BlockedTaskRun = {
  readonly kind: "blocked";
  readonly taskId: TaskId;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly reason: string;
  readonly cleanup?: WorktreeCleanupOutcome | undefined;
};

export type WorkflowTaskRunOutcome =
  | CompletedTaskRun
  | FailedTaskRun
  | CancelledTaskRun
  | BlockedTaskRun
  | PendingIntegrationTaskRun
  | RejectedTaskRun;
