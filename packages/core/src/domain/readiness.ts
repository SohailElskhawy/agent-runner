import type { PlanningQuestion, PlanningResult } from "./planning-result.js";

export type ReadinessResult = {
  readonly status: "NEEDS_DISCOVERY" | "READY_FOR_PLANNING";
  readonly questions: readonly PlanningQuestion[];
  readonly reasons: readonly string[];
};

export function assessReadiness(result: PlanningResult, answeredQuestionIds: readonly string[] = []): ReadinessResult {
  if (result.kind === "READY_FOR_PLANNING") return { status: "READY_FOR_PLANNING", questions: [], reasons: [] };
  const answered = new Set(answeredQuestionIds);
  const blockers = result.questions.filter((question) => question.importance === "important" && !answered.has(question.id));
  return {
    status: blockers.length ? "NEEDS_DISCOVERY" : "READY_FOR_PLANNING",
    questions: blockers,
    reasons: blockers.map((question) => `${question.id}: ${question.prompt} — ${question.reason}`),
  };
}
