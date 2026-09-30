import { describe, expect, it } from "vitest";
import { assessReadiness, type PlanningResult } from "@agentic-dev-runner/core";

const needsDiscovery: PlanningResult = { version: 1, kind: "NEEDS_DISCOVERY", questions: [
  { id: "database", prompt: "Which database?", reason: "It sets the persistence boundary.", importance: "important", choices: ["SQLite", "PostgreSQL"] },
  { id: "button-color", prompt: "Which button color?", reason: "It affects a reversible visual detail.", importance: "low-risk", choices: ["Blue", "Green"] },
] };

describe("assessReadiness", () => {
  it("does not repeat answered questions and does not block on low-risk details", () => {
    expect(assessReadiness(needsDiscovery, ["database"])).toEqual({ status: "READY_FOR_PLANNING", questions: [], reasons: [] });
  });

  it("reports important unanswered decisions as inspectable blockers", () => {
    expect(assessReadiness(needsDiscovery, [])).toEqual({ status: "NEEDS_DISCOVERY", questions: [needsDiscovery.questions[0]], reasons: ["database: Which database? — It sets the persistence boundary."] });
  });

  it("accepts a defined project without low-risk implementation questions", () => {
    const ready: PlanningResult = { version: 1, kind: "READY_FOR_PLANNING", milestones: [{ id: "M1", title: "Build", completionCriteria: ["Build succeeds."] }], tasks: [{ id: "T1" }] };
    expect(assessReadiness(ready)).toEqual({ status: "READY_FOR_PLANNING", questions: [], reasons: [] });
  });
});
