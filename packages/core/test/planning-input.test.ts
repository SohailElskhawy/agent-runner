import { describe, expect, it } from "vitest";
import { validatePlanningInput } from "@agentic-dev-runner/core";

describe("validatePlanningInput", () => {
  it("accepts an empty repository and preserves evidence order", () => {
    const empty = validatePlanningInput({
      repositoryRoot: "/project", goal: "Build it", baseRevision: "abc",
      repositoryEvidence: [], knownDecisions: [], answeredQuestionIds: [], existingTaskIds: [],
    });
    expect(empty).toEqual({ ok: true, value: {
      repositoryRoot: "/project", goal: "Build it", baseRevision: "abc",
      repositoryEvidence: [], knownDecisions: [], answeredQuestionIds: [], existingTaskIds: [],
    } });

    const evidence = [
      { path: "AGENTS.md", status: "present", content: "first" },
      { path: "docs/ADR.md", status: "absent" },
    ];
    const result = validatePlanningInput({
      repositoryRoot: "/project", goal: "Build it", baseRevision: "abc",
      repositoryEvidence: evidence, knownDecisions: ["Use SQLite"], answeredQuestionIds: ["Q1"], existingTaskIds: ["T1"],
    });
    expect(result.ok && result.value.repositoryEvidence).toEqual(evidence);
  });

  it("rejects malformed required fields and evidence records", () => {
    const result = validatePlanningInput({
      repositoryRoot: " ", goal: "", baseRevision: "abc",
      repositoryEvidence: [{ path: "x", status: "present" }],
      knownDecisions: [3], answeredQuestionIds: [3], existingTaskIds: [""],
    });
    expect(result.ok).toBe(false);
  });
});
