import { describe, expect, it } from "vitest";
import { parsePlanningResult } from "@agentic-dev-runner/core";

const question = { id: "database", prompt: "Which database?", reason: "It sets the persistence boundary.", importance: "important", choices: ["SQLite", "PostgreSQL"] };
const milestone = { id: "M1", title: "Foundation", completionCriteria: ["The app builds."] };
const task = { id: "T1", title: "Create project", milestone: "M1" };

describe("parsePlanningResult", () => {
  it("parses both version-1 result variants", () => {
    expect(parsePlanningResult({ version: 1, kind: "NEEDS_DISCOVERY", questions: [question] })).toEqual({ ok: true, value: { version: 1, kind: "NEEDS_DISCOVERY", questions: [question] } });
    expect(parsePlanningResult({ version: 1, kind: "READY_FOR_PLANNING", milestones: [milestone], tasks: [task] })).toEqual({ ok: true, value: { version: 1, kind: "READY_FOR_PLANNING", milestones: [milestone], tasks: [task] } });
  });

  it("rejects unknown versions and result kinds", () => {
    expect(parsePlanningResult({ version: 2, kind: "NEEDS_DISCOVERY", questions: [question] }).ok).toBe(false);
    expect(parsePlanningResult({ version: 1, kind: "UNKNOWN" }).ok).toBe(false);
  });

  it("reports malformed and empty questions and missing choices", () => {
    const empty = parsePlanningResult({ version: 1, kind: "NEEDS_DISCOVERY", questions: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.issues).toContain("planning result.questions: must contain at least one question");
    const malformed = parsePlanningResult({ version: 1, kind: "NEEDS_DISCOVERY", questions: [{ ...question, prompt: " ", choices: [] }] });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.issues.join(" ")).toContain("choices");
  });

  it("rejects duplicate question IDs", () => {
    const result = parsePlanningResult({ version: 1, kind: "NEEDS_DISCOVERY", questions: [question, { ...question, prompt: "Another decision?" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('planning result.questions[1].id: duplicates "database"');
  });

  it("requires milestone completion criteria", () => {
    const result = parsePlanningResult({ version: 1, kind: "READY_FOR_PLANNING", milestones: [{ id: "M1", title: "Foundation", completionCriteria: [] }], tasks: [task] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("completionCriteria");
  });
});
