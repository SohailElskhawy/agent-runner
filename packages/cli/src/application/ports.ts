import type {
  ExecutionClaimStatus,
  IntegrationQueueStatus,
  Project,
  Task,
  TaskId,
  TaskStatus,
} from "@agentic-dev-runner/core";

export type InitResult = {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly storePath: string;
};

export type AddTaskResult = {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: Task["status"];
};

export type RunResult =
  | { readonly kind: "completed"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string };

export type ApprovalCommandResult = {
  readonly kind: "granted" | "already-granted" | "rejected";
  readonly taskId: string;
  readonly message: string;
};

export type RetryCommandResult = {
  readonly kind: "accepted" | "rejected";
  readonly taskId: string;
  readonly message: string;
};

/** Per-run unattended scheduling request. */
export type UnattendedRunRequest = {
  readonly maxParallelism?: number | undefined;
};

export type AgentStatusEntry = {
  readonly id: string;
  readonly available: boolean;
  readonly version: string | null;
  readonly reason: string | null;
};

export type ProjectStatus = {
  readonly project: Project | null;
  readonly tasks: readonly TaskStatusEntry[];
  readonly scheduler: SchedulerStatus;
};

/**
 * Scheduler-aware project snapshot. Everything is derived from persisted
 * authoritative state; no CLI-only runtime state is maintained.
 */
export type SchedulerStatus = {
  readonly totalsByState: Readonly<Record<TaskStatus, number>>;
  readonly activeTaskIds: readonly TaskId[];
  readonly blockedTaskIds: readonly TaskId[];
  readonly failedTaskIds: readonly TaskId[];
  readonly recoveryRequiredTaskIds: readonly TaskId[];
  readonly activeClaims: readonly ExecutionClaimStatusView[];
  readonly recoveryRequiredClaims: readonly ExecutionClaimStatusView[];
  readonly integrationQueue: IntegrationQueueStateSummary;
  readonly parallelCapacity: ParallelCapacityUsage;
};

export type ExecutionClaimStatusView = {
  readonly executionId: string;
  readonly taskId: string;
  readonly status: ExecutionClaimStatus;
  readonly claimedAt: string;
  readonly renewedAt: string;
  readonly leaseExpiresAt: string;
};

export type IntegrationQueueStateSummary = {
  readonly totalsByStatus: Readonly<Record<IntegrationQueueStatus, number>>;
  readonly pendingTaskIds: readonly TaskId[];
  readonly integrating: {
    readonly taskId: string;
    readonly attemptId: string;
  } | null;
};

export type ParallelCapacityUsage = {
  readonly maxParallelism: number;
  readonly activeExecutions: number;
  readonly remainingSlots: number;
};

export type TaskStatusEntry = {
  readonly id: string;
  readonly title: string;
  readonly status: Task["status"];
  readonly updatedAt: string;
  readonly attemptCount: number;
  readonly latestAttempt: LatestAttemptSummary | null;
  readonly approval?:
    | { readonly required: boolean; readonly granted: boolean }
    | undefined;
};

export type LatestAttemptSummary = {
  readonly id: string;
  readonly number: number;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failureMessage: string | null;
};

export type TaskInspection = {
  readonly task: Task;
  readonly attempts: readonly TaskInspectionAttempt[];
  readonly events: readonly TaskInspectionEvent[];
  readonly claims: readonly ExecutionClaimStatusView[];
  readonly integrationQueue: readonly TaskInspectionQueueEntry[];
  readonly recoveryEvents: readonly TaskInspectionEvent[];
  readonly failureReason: string | null;
};

export type TaskInspectionAttempt = {
  readonly id: string;
  readonly number: number;
  readonly status: string;
  readonly agent: string;
  readonly model: string | null;
  readonly baseRevision: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failure: { readonly kind: string; readonly message: string | null } | null;
  readonly commit: { readonly revision: string; readonly message: string } | null;
  readonly integration: { readonly revision: string; readonly kind: string } | null;
  readonly stages: readonly TaskInspectionStage[];
  readonly verification: TaskInspectionVerification | null;
  readonly integrationVerification: TaskInspectionVerification | null;
};

export type TaskInspectionStage = {
  readonly stage: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failure: { readonly kind: string; readonly message: string | null } | null;
};

export type TaskInspectionVerification = {
  readonly status: string;
  readonly revision: string | null;
  readonly checks: readonly {
    readonly kind: string;
    readonly outcome: string;
    readonly message: string | null;
  }[];
};

export type TaskInspectionQueueEntry = {
  readonly id: string;
  readonly sequence: number;
  readonly status: string;
  readonly taskRevision: string;
  readonly branch: string;
  readonly enqueuedAt: string;
  readonly finishedAt: string | null;
  readonly failureMessage: string | null;
};

export type TaskInspectionEvent = {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: unknown;
};
