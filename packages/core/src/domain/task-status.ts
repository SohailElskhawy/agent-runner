export const TASK_STATUSES = [
  "BACKLOG",
  "READY",
  "PLANNING",
  "PLAN_REVIEW",
  "IMPLEMENTING",
  "CODE_REVIEW",
  "VERIFYING",
  "INTEGRATING",
  "DONE",
  "BLOCKED",
  "NEEDS_HUMAN",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}
