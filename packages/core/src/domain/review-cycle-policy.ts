/**
 * Pure, deterministic bounded review/fix-loop policy.
 *
 * The policy decides what the runner may do next after one review result has
 * been produced for an attempt: accept the reviewed output (the gate passes),
 * permit exactly one more fix/review cycle, or declare the configured
 * review-cycle budget exhausted. It is shared by every review family
 * (PLAN_REVIEW, CODE_REVIEW) so no parallel, incompatible limit logic exists.
 *
 * Cycle semantics: `completedReviewCycles` is the number of review results
 * already produced for the attempt, INCLUDING the review result currently
 * being evaluated. A review stage must not run again once the number of
 * produced review results reaches `maxReviewCycles`, so:
 *
 *   maxReviewCycles = 2
 *   - first CHANGES_REQUIRED  → another fix/review cycle is allowed
 *   - second CHANGES_REQUIRED → limit exhausted
 *   - a third review must never be permitted
 *
 * The policy is pure and deterministic: identical input always produces an
 * identical result. It performs no persistence, no agent execution, and no
 * task-state transitions; it never mutates anything. Inconsistent input is
 * rejected through a structured result instead of throwing, mirroring the
 * workflow-definition validation contract.
 */

import type { ReviewDecision } from "./stage-run.js";

/**
 * The exhaustive set of decisions the policy can produce for the runner.
 * `PASSED` means the review accepted the output and the review gate is
 * satisfied; `FIX_ALLOWED` means the review required changes and the budget
 * still permits one more fix/review cycle; `LIMIT_EXHAUSTED` means the
 * review required changes and the configured budget is used up.
 */
export const REVIEW_CYCLE_OUTCOMES = [
  "PASSED",
  "FIX_ALLOWED",
  "LIMIT_EXHAUSTED",
] as const;

export type ReviewCycleOutcome = (typeof REVIEW_CYCLE_OUTCOMES)[number];

export type ReviewCycleEvaluationInput = {
  /** Decision of the review result currently being evaluated. */
  readonly decision: ReviewDecision;
  /**
   * Number of review results already produced for the attempt, including the
   * one currently being evaluated.
   */
  readonly completedReviewCycles: number;
  /** Maximum number of review results the attempt may ever produce. */
  readonly maxReviewCycles: number;
};

export type ReviewCycleRejectionReason =
  | {
      readonly reason: "invalid-max-review-cycles";
      readonly maxReviewCycles: number;
    }
  | {
      readonly reason: "invalid-completed-review-cycles";
      readonly completedReviewCycles: number;
    }
  | {
      readonly reason: "inconsistent-review-cycle-count";
      readonly completedReviewCycles: number;
      readonly maxReviewCycles: number;
    };

export type ReviewCycleEvaluation =
  | { readonly accepted: true; readonly outcome: ReviewCycleOutcome }
  | {
      readonly accepted: false;
      readonly rejection: ReviewCycleRejectionReason;
    };

/**
 * Evaluates one produced review result against the configured review-cycle
 * budget. An `APPROVED` review never requests another cycle. A
 * `CHANGES_REQUIRED` review permits another fix/review cycle only while
 * fewer review results have been produced than `maxReviewCycles`.
 */
export function evaluateReviewCycle(
  input: ReviewCycleEvaluationInput,
): ReviewCycleEvaluation {
  if (!isPositiveInteger(input.maxReviewCycles)) {
    return {
      accepted: false,
      rejection: {
        reason: "invalid-max-review-cycles",
        maxReviewCycles: input.maxReviewCycles,
      },
    };
  }
  if (!isNonNegativeInteger(input.completedReviewCycles)) {
    return {
      accepted: false,
      rejection: {
        reason: "invalid-completed-review-cycles",
        completedReviewCycles: input.completedReviewCycles,
      },
    };
  }
  if (input.completedReviewCycles > input.maxReviewCycles) {
    return {
      accepted: false,
      rejection: {
        reason: "inconsistent-review-cycle-count",
        completedReviewCycles: input.completedReviewCycles,
        maxReviewCycles: input.maxReviewCycles,
      },
    };
  }
  if (input.decision === "APPROVED") {
    return { accepted: true, outcome: "PASSED" };
  }
  if (input.completedReviewCycles >= input.maxReviewCycles) {
    return { accepted: true, outcome: "LIMIT_EXHAUSTED" };
  }
  return { accepted: true, outcome: "FIX_ALLOWED" };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
