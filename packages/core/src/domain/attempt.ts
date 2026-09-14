import type { IsoTimestamp } from "./timestamp.js";

export const ATTEMPT_STATUSES = [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type AttemptFailure = {
  kind: "error" | "timeout" | "cancelled" | "verification_failed";
  message?: string;
};

export type Attempt = {
  id: string;
  taskId: string;
  number: number;
  status: AttemptStatus;
  agent: string;
  model?: string;
  baseRevision: string;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: AttemptFailure;
};
