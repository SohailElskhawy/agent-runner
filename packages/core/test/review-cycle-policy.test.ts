import { describe, expect, it } from "vitest";
import {
  REVIEW_CYCLE_OUTCOMES,
  evaluateReviewCycle,
} from "../src/domain/review-cycle-policy.js";

describe("evaluateReviewCycle (M058a)", () => {
  it("accepts an APPROVED first-cycle review", () => {
    const evaluation = evaluateReviewCycle({
      decision: "APPROVED",
      completedReviewCycles: 1,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({ accepted: true, outcome: "PASSED" });
  });

  it("accepts an APPROVED review on the final allowed cycle", () => {
    const evaluation = evaluateReviewCycle({
      decision: "APPROVED",
      completedReviewCycles: 2,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({ accepted: true, outcome: "PASSED" });
  });

  it("permits another cycle while CHANGES_REQUIRED reviews remain in budget", () => {
    const evaluation = evaluateReviewCycle({
      decision: "CHANGES_REQUIRED",
      completedReviewCycles: 1,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({ accepted: true, outcome: "FIX_ALLOWED" });
  });

  it("exhausts the limit when a CHANGES_REQUIRED review consumes the last cycle", () => {
    const evaluation = evaluateReviewCycle({
      decision: "CHANGES_REQUIRED",
      completedReviewCycles: 2,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({ accepted: true, outcome: "LIMIT_EXHAUSTED" });
  });

  it("exhausts a single-cycle budget on the first CHANGES_REQUIRED review", () => {
    const evaluation = evaluateReviewCycle({
      decision: "CHANGES_REQUIRED",
      completedReviewCycles: 1,
      maxReviewCycles: 1,
    });

    expect(evaluation).toEqual({ accepted: true, outcome: "LIMIT_EXHAUSTED" });
  });

  it("never permits another cycle after an APPROVED review regardless of count", () => {
    for (let count = 1; count <= 3; count += 1) {
      const evaluation = evaluateReviewCycle({
        decision: "APPROVED",
        completedReviewCycles: count,
        maxReviewCycles: 3,
      });

      expect(evaluation).toEqual({ accepted: true, outcome: "PASSED" });
    }
  });

  it("rejects a zero maxReviewCycles", () => {
    const evaluation = evaluateReviewCycle({
      decision: "APPROVED",
      completedReviewCycles: 1,
      maxReviewCycles: 0,
    });

    expect(evaluation).toEqual({
      accepted: false,
      rejection: {
        reason: "invalid-max-review-cycles",
        maxReviewCycles: 0,
      },
    });
  });

  it("rejects a negative maxReviewCycles", () => {
    const evaluation = evaluateReviewCycle({
      decision: "APPROVED",
      completedReviewCycles: 1,
      maxReviewCycles: -1,
    });

    expect(evaluation).toEqual({
      accepted: false,
      rejection: {
        reason: "invalid-max-review-cycles",
        maxReviewCycles: -1,
      },
    });
  });

  it("rejects a non-integer maxReviewCycles", () => {
    const evaluation = evaluateReviewCycle({
      decision: "APPROVED",
      completedReviewCycles: 1,
      maxReviewCycles: 1.5,
    });

    expect(evaluation).toEqual({
      accepted: false,
      rejection: {
        reason: "invalid-max-review-cycles",
        maxReviewCycles: 1.5,
      },
    });
  });

  it("rejects a negative completedReviewCycles count", () => {
    const evaluation = evaluateReviewCycle({
      decision: "CHANGES_REQUIRED",
      completedReviewCycles: -1,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({
      accepted: false,
      rejection: {
        reason: "invalid-completed-review-cycles",
        completedReviewCycles: -1,
      },
    });
  });

  it("rejects a non-integer completedReviewCycles count", () => {
    const evaluation = evaluateReviewCycle({
      decision: "CHANGES_REQUIRED",
      completedReviewCycles: 0.5,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({
      accepted: false,
      rejection: {
        reason: "invalid-completed-review-cycles",
        completedReviewCycles: 0.5,
      },
    });
  });

  it("rejects a completedReviewCycles count greater than the configured limit", () => {
    const evaluation = evaluateReviewCycle({
      decision: "CHANGES_REQUIRED",
      completedReviewCycles: 3,
      maxReviewCycles: 2,
    });

    expect(evaluation).toEqual({
      accepted: false,
      rejection: {
        reason: "inconsistent-review-cycle-count",
        completedReviewCycles: 3,
        maxReviewCycles: 2,
      },
    });
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      decision: "CHANGES_REQUIRED" as const,
      completedReviewCycles: 1,
      maxReviewCycles: 2,
    };

    expect(evaluateReviewCycle(input)).toEqual(evaluateReviewCycle(input));
  });

  it("exposes exactly the documented outcome set", () => {
    expect([...REVIEW_CYCLE_OUTCOMES]).toEqual([
      "PASSED",
      "FIX_ALLOWED",
      "LIMIT_EXHAUSTED",
    ]);
  });
});
