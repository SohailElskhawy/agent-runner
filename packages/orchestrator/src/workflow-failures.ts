/**
 * Deterministic failure resolution for the resolved workflow lifecycle.
 *
 * Maps the failure kinds the lifecycle can produce onto explicit
 * authoritative attempt/task/outcome states using the existing state
 * machine semantics:
 *
 *   - stage execution errors        → FAILED attempt, FAILED task
 *   - stage timeouts                → TIMED_OUT attempt, FAILED task
 *   - stage cancellations           → CANCELLED attempt, CANCELLED task
 *   - review-cycle exhaustion       → FAILED attempt, BLOCKED task
 *   - verification failure          → FAILED attempt, FAILED task
 *   - integration-verification fail → FAILED attempt, FAILED task
 *
 * Review-cycle exhaustion is distinguished from retryable execution
 * failure: the bounded review/fix budget is used up, so re-running the task
 * requires a human unblocking decision (BLOCKED → READY) rather than an
 * automatic retry. Every resolution preserves the original failure message
 * as durable evidence; no resolution ever reaches DONE, and there are no
 * retries or scheduler policy here.
 */

import type { Attempt, AttemptFailure } from "@agentic-dev-runner/core";

export type WorkflowFailureKind =
  | "error"
  | "timeout"
  | "cancelled"
  | "verification_failed"
  | "review_exhausted";

export class WorkflowExecutionFailure extends Error {
  readonly kind: WorkflowFailureKind;

  constructor(kind: WorkflowFailureKind, message: string) {
    super(message);
    this.name = "WorkflowExecutionFailure";
    this.kind = kind;
  }
}

export type WorkflowFailureResolution = {
  readonly taskStatus: "BLOCKED" | "FAILED" | "CANCELLED";
  readonly attemptStatus: Attempt["status"];
  readonly attemptFailure: AttemptFailure;
  readonly outcomeKind: "blocked" | "failed" | "cancelled";
};

export function resolveWorkflowFailure(
  kind: WorkflowFailureKind,
  message: string,
): WorkflowFailureResolution {
  switch (kind) {
    case "cancelled":
      return {
        taskStatus: "CANCELLED",
        attemptStatus: "CANCELLED",
        attemptFailure: { kind: "cancelled", message },
        outcomeKind: "cancelled",
      };
    case "timeout":
      return {
        taskStatus: "FAILED",
        attemptStatus: "TIMED_OUT",
        attemptFailure: { kind: "timeout", message },
        outcomeKind: "failed",
      };
    case "verification_failed":
      return {
        taskStatus: "FAILED",
        attemptStatus: "FAILED",
        attemptFailure: { kind: "verification_failed", message },
        outcomeKind: "failed",
      };
    case "review_exhausted":
      return {
        taskStatus: "BLOCKED",
        attemptStatus: "FAILED",
        attemptFailure: { kind: "error", message },
        outcomeKind: "blocked",
      };
    case "error":
      return {
        taskStatus: "FAILED",
        attemptStatus: "FAILED",
        attemptFailure: { kind: "error", message },
        outcomeKind: "failed",
      };
  }
}

export function toWorkflowExecutionFailure(
  error: unknown,
  describeError: (error: unknown) => string,
): WorkflowExecutionFailure {
  if (error instanceof WorkflowExecutionFailure) {
    return error;
  }
  return new WorkflowExecutionFailure("error", describeError(error));
}
