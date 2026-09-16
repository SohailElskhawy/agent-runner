/**
 * Shared reviewer-output contract for review stages (PLAN_REVIEW,
 * CODE_REVIEW).
 *
 * Every review stage asks its reviewer for a single JSON review object on
 * stdout and normalizes it into the shared, runner-consumable
 * `ReviewResult` domain type. Reviewers are untrusted workers: their raw
 * output is never treated as authoritative state, and anything missing,
 * malformed, or outside the contract is rejected as a review-stage failure.
 */

import type {
  ReviewDecision,
  ReviewResult,
} from "@agentic-dev-runner/core";
import { REVIEW_DECISIONS } from "@agentic-dev-runner/core";
import type { AgentOutput } from "@agentic-dev-runner/agents";
import type { StageKind } from "@agentic-dev-runner/core";

/**
 * Normalizes the agent's raw stdout into the structured review result.
 * Returns the structured result, or a rejection message when the output is
 * missing, malformed, or violates the review contract.
 */
export function parseStructuredReview(
  output: AgentOutput,
  stage: StageKind,
): ReviewResult | string {
  const raw = output.stdout?.trim() ?? "";
  if (raw.length === 0) {
    return "the agent produced no review output";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `malformed ${stage} output: the agent must reply with a single JSON review object`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `malformed ${stage} output: the review must be a JSON object`;
  }
  const record = parsed as Record<string, unknown>;
  const decision = record["decision"];
  if (typeof decision !== "string") {
    return `malformed ${stage} output: missing or invalid review decision`;
  }
  if (!isReviewDecision(decision)) {
    return `malformed ${stage} output: unknown review decision "${decision}"`;
  }
  const feedbackValue = record["feedback"];
  if (feedbackValue !== undefined && typeof feedbackValue !== "string") {
    return `malformed ${stage} output: review feedback must be a non-empty string when provided`;
  }
  if (decision === "CHANGES_REQUIRED") {
    const feedback =
      typeof feedbackValue === "string" ? feedbackValue.trim() : "";
    if (feedback.length === 0) {
      return `malformed ${stage} output: CHANGES_REQUIRED requires actionable feedback`;
    }
    return { decision, feedback };
  }
  const approvedFeedback =
    typeof feedbackValue === "string" ? feedbackValue.trim() : "";
  return approvedFeedback.length > 0
    ? { decision, feedback: approvedFeedback }
    : { decision };
}

function isReviewDecision(value: string): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly string[]).includes(value);
}
