import type { TaskStatus } from "./task-status.js";

export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  BACKLOG: [],
  READY: ["IMPLEMENTING", "BLOCKED", "FAILED", "CANCELLED"],
  PLANNING: [],
  PLAN_REVIEW: [],
  IMPLEMENTING: [
    "VERIFYING",
    "BLOCKED",
    "NEEDS_HUMAN",
    "FAILED",
    "CANCELLED",
  ],
  CODE_REVIEW: [],
  VERIFYING: ["INTEGRATING", "BLOCKED", "NEEDS_HUMAN", "FAILED", "CANCELLED"],
  INTEGRATING: ["DONE", "BLOCKED", "NEEDS_HUMAN", "FAILED", "CANCELLED"],
  DONE: [],
  BLOCKED: ["READY"],
  NEEDS_HUMAN: [],
  FAILED: ["DONE"],
  CANCELLED: [],
};

export function getTaskStatusTransitions(
  from: TaskStatus,
): readonly TaskStatus[] {
  return TASK_STATUS_TRANSITIONS[from];
}

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return getTaskStatusTransitions(from).includes(to);
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
