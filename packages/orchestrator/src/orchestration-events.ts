import type { AttemptFailure, TaskStatus, VerificationResult } from "@agentic-dev-runner/core";

export const ORCHESTRATION_EVENTS = {
  attemptStarted: "attempt.started",
  taskTransitioned: "task.transitioned",
  worktreeCreated: "worktree.created",
  implementationCompleted: "implementation.completed",
  verificationCompleted: "verification.completed",
  commitCreated: "commit.created",
  integrationCompleted: "integration.completed",
  worktreeCleanupFailed: "worktree.cleanup.failed",
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
  readonly status: "PASSED" | "FAILED" | "CANCELLED";
  readonly checks: readonly VerificationResult[];
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

export type WorktreeCleanupFailedPayload = {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly reason: string;
};
