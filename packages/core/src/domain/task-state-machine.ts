import type { TaskStatus } from "./task-status.js";

/**
 * Canonical workflow lifecycle transitions. Each authoritative workflow stage
 * has a matching lifecycle state (PLAN → PLANNING, PLAN_REVIEW, IMPLEMENT →
 * IMPLEMENTING, CODE_REVIEW, VERIFY → VERIFYING, INTEGRATE → INTEGRATING, DONE
 * after successful integration only). Optional workflow stages are skipped by
 * the executor, so a state may legally advance past a stage the workflow does
 * not contain (for example PLANNING → IMPLEMENTING when no PLAN_REVIEW stage
 * exists). Review/fix loops are legal through the reverse review transitions
 * (PLAN_REVIEW → PLANNING, CODE_REVIEW → IMPLEMENTING). Every active state can
 * escalate to BLOCKED, FAILED, or CANCELLED. The runner may return BLOCKED,
 * NEEDS_HUMAN, or FAILED tasks to READY through an explicit retry, bounded by
 * the task attempt budget and approval state.
 */
export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  BACKLOG: [],
  READY: ["PLANNING", "IMPLEMENTING", "BLOCKED", "FAILED", "CANCELLED"],
  PLANNING: ["PLAN_REVIEW", "IMPLEMENTING", "BLOCKED", "FAILED", "CANCELLED"],
  PLAN_REVIEW: ["PLANNING", "IMPLEMENTING", "BLOCKED", "FAILED", "CANCELLED"],
  IMPLEMENTING: ["CODE_REVIEW", "VERIFYING", "BLOCKED", "FAILED", "CANCELLED"],
  CODE_REVIEW: ["IMPLEMENTING", "VERIFYING", "BLOCKED", "FAILED", "CANCELLED"],
  VERIFYING: ["INTEGRATING", "BLOCKED", "FAILED", "CANCELLED"],
  INTEGRATING: ["DONE", "BLOCKED", "FAILED", "CANCELLED"],
  DONE: [],
  BLOCKED: ["READY"],
  NEEDS_HUMAN: ["READY"],
  FAILED: ["READY"],
  CANCELLED: [],
};

export const RECOVERY_STATUS_TRANSITIONS: Readonly<
  Partial<Record<TaskStatus, readonly TaskStatus[]>>
> = {
  PLANNING: ["NEEDS_HUMAN"],
  PLAN_REVIEW: ["NEEDS_HUMAN"],
  IMPLEMENTING: ["NEEDS_HUMAN"],
  CODE_REVIEW: ["NEEDS_HUMAN"],
  VERIFYING: ["NEEDS_HUMAN"],
  INTEGRATING: ["NEEDS_HUMAN"],
  FAILED: ["DONE"],
};

export function getTaskStatusTransitions(
  from: TaskStatus,
): readonly TaskStatus[] {
  return TASK_STATUS_TRANSITIONS[from];
}

export function getTaskRecoveryStatusTransitions(
  from: TaskStatus,
): readonly TaskStatus[] {
  return RECOVERY_STATUS_TRANSITIONS[from] ?? [];
}

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return getTaskStatusTransitions(from).includes(to);
}

export function canReconcileTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return (
    canTransitionTaskStatus(from, to) ||
    getTaskRecoveryStatusTransitions(from).includes(to)
  );
}

export type TaskTransitionResult =
  | { readonly ok: true; readonly from: TaskStatus; readonly to: TaskStatus }
  | { readonly ok: false; readonly from: TaskStatus; readonly to: TaskStatus };

export function checkTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
): TaskTransitionResult {
  return canTransitionTaskStatus(from, to)
    ? { ok: true, from, to }
    : { ok: false, from, to };
}

export class TaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Illegal task status transition: ${from} -> ${to}`);
    this.name = "TaskTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTaskStatus(from, to)) {
    throw new TaskTransitionError(from, to);
  }
}

export function assertReconcileTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): void {
  if (!canReconcileTaskStatus(from, to)) {
    throw new TaskTransitionError(from, to);
  }
}
