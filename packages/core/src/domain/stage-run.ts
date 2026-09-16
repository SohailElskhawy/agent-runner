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
 * Deterministic decisions a review stage can produce for the output it
 * reviews. A review either accepts the reviewed output or requires changes;
 * there are no other decisions. The contract is shared by every review stage
 * (PLAN_REVIEW, CODE_REVIEW) so no parallel, incompatible abstraction exists.
 */
export const REVIEW_DECISIONS = [
  "APPROVED",
  "CHANGES_REQUIRED",
] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Structured, runner-consumable review result produced by a review stage.
 * `CHANGES_REQUIRED` carries actionable feedback; `APPROVED` is representable
 * without feedback.
 */
export type ReviewResult = {
  readonly decision: ReviewDecision;
  readonly feedback?: string | undefined;
};

/**
 * PLAN_REVIEW-specific aliases of the shared review contract.
 */
export const PLAN_REVIEW_DECISIONS: readonly ReviewDecision[] = REVIEW_DECISIONS;
export type PlanReviewDecision = ReviewDecision;
export type PlanReviewResult = ReviewResult;

/**
 * Durable stage output. A stage that produced a usable result persists that
 * result here (for `PLAN`, the plan as plain text; for review stages, the
 * structured review result); a stage that terminated unsuccessfully preserves
 * the agent's normalized stdout/stderr so failure information survives
 * process termination.
 */
export type StageRunOutput = {
  readonly plan?: string | undefined;
  readonly planReview?: PlanReviewResult | undefined;
  readonly codeReview?: ReviewResult | undefined;
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
