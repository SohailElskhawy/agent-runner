import type { IsoTimestamp } from "./timestamp.js";
import type { AttemptId, StageRunId } from "./ids.js";

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

/**
 * Durable stage output. A stage that produced a usable result persists that
 * result here (for `PLAN`, the plan as plain text); a stage that terminated
 * unsuccessfully preserves the agent's normalized stdout/stderr so failure
 * information survives process termination.
 */
export type StageRunOutput = {
  readonly plan?: string | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
};

export type StageRun = {
  id: StageRunId;
  attemptId: AttemptId;
  stage: StageKind;
  status: StageRunStatus;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: StageRunFailure;
  output?: StageRunOutput;
};
