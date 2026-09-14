import type { IsoTimestamp } from "./timestamp.js";

export const STAGE_KINDS = [
  "PLAN",
  "PLAN_REVIEW",
  "IMPLEMENT",
  "CODE_REVIEW",
  "VERIFY",
  "INTEGRATE",
] as const;

export type StageKind = (typeof STAGE_KINDS)[number];

export const STAGE_RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

export type StageRunStatus = (typeof STAGE_RUN_STATUSES)[number];

export type StageRunFailure = {
  kind: "error" | "timeout" | "cancelled" | "review_rejected";
  message?: string;
};

export type StageRun = {
  id: string;
  attemptId: string;
  stage: StageKind;
  status: StageRunStatus;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: StageRunFailure;
};
