import type { AttemptFailure, TaskStatus, VerificationResult } from "@agentic-dev-runner/core";

export const ORCHESTRATION_EVENTS = {
  attemptStarted: "attempt.started",
  taskTransitioned: "task.transitioned",
  worktreeCreated: "worktree.created",
  implementationCompleted: "implementation.completed",
  verificationCompleted: "verification.completed",
  commitCreated: "commit.created",
  integrationQueued: "integration.queued",
  integrationCompleted: "integration.completed",
  integrationVerificationCompleted: "integration.verification.completed",
  worktreeCleanupFailed: "worktree.cleanup.failed",
  recoveryReconciled: "recovery.reconciled",
} as const;

export type OrchestrationEventType =
  (typeof ORCHESTRATION_EVENTS)[keyof typeof ORCHESTRATION_EVENTS];

export type AttemptStartedPayload = {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly agent: string;
  readonly baseRevision: string;
};

export type TaskTransitionedPayload = {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly attemptId?: string | undefined;
  readonly failure?: Pick<AttemptFailure, "kind" | "message"> | undefined;
};

export type WorktreeCreatedPayload = {
  readonly attemptId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseRevision: string;
};

export type ImplementationCompletedPayload = {
  readonly attemptId: string;
  readonly changedPaths: readonly string[];
};

export type VerificationCompletedPayload = {
  readonly attemptId: string;
  /** Revision verified when the pass was performed after reconciliation. */
  readonly revision?: string | undefined;
  readonly status: "PASSED" | "FAILED" | "CANCELLED";
  readonly checks: readonly VerificationResult[];
};

export type IntegrationQueuedPayload = {
  readonly attemptId: string;
  readonly revision: string;
  readonly branch: string;
};

export type CommitCreatedPayload = {
  readonly attemptId: string;
  readonly revision: string;
  readonly message: string;
};

export type IntegrationCompletedPayload = {
  readonly attemptId: string;
  readonly revision: string;
  readonly kind: "fast-forward" | "already-integrated";
};

/**
 * Verification evidence for the integrated result. This is a distinct event
 * from `verification.completed` (which covers the task-worktree pass):
 * integration verification is the authoritative gate before a task may be
 * marked DONE, and it records the integrated revision it verified.
 */
export type IntegrationVerificationCompletedPayload = {
  readonly attemptId: string;
  readonly revision: string;
  readonly status: "PASSED" | "FAILED" | "CANCELLED";
  readonly checks: readonly VerificationResult[];
};

export type WorktreeCleanupFailedPayload = {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly reason: string;
};

export type RecoveryOutcomeKind =
  | "completed"
  | "safe-to-retry"
  | "requires-reconciliation"
  | "requires-human"
  | "failed"
  | "cancelled";

export type RecoveryReconciledPayload = {
  readonly attemptId?: string | undefined;
  readonly fromStatus: TaskStatus;
  readonly outcome: RecoveryOutcomeKind;
  readonly detail: string;
  readonly revision?: string | undefined;
};
