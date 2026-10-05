import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanningInput, PlanningQuestion, PlanningResult } from "@agentic-dev-runner/core";
import { readPlanDraft, writeDiscoveryQuestions, writePlanDraft } from "../src/application/planning/plan-files.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "agentic-planning-files-"));
  roots.push(path);
  return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const input: PlanningInput = {
  repositoryRoot: "/repo", goal: "build a todo app", baseRevision: "abc",
  repositoryEvidence: [], knownDecisions: [], answeredQuestionIds: [], existingTaskIds: [],
};
const questions: PlanningQuestion[] = [{ id: "AUTH", prompt: "How should sign-in work?", reason: "It changes data access.", importance: "important", choices: ["No sign-in", "Email"] }];
const result: PlanningResult = {
  version: 1, kind: "READY_FOR_PLANNING",
  milestones: [{ id: "M1", title: "App", completionCriteria: ["Works"] }],
  tasks: [{ id: "T1" }],
};

describe("planning files", () => {
  it("writes stable question-ID headings and preserves existing answers", async () => {
    const projectRoot = root();
    await writeDiscoveryQuestions(projectRoot, questions);
    writeFileSync(join(projectRoot, ".agentic", "decisions.md"), "# Decisions\n\n### AUTH: old wording\nAnswer: Email only\n");
    await writeDiscoveryQuestions(projectRoot, questions);
    const markdown = readFileSync(join(projectRoot, ".agentic", "decisions.md"), "utf8");
    expect(markdown).toContain("### AUTH: How should sign-in work?");
    expect(markdown).toContain("Answer: Email only");
  });

  it("retains an answered decision when the next result asks a different question", async () => {
    const projectRoot = root();
    await writeDiscoveryQuestions(projectRoot, questions);
    writeFileSync(join(projectRoot, ".agentic", "decisions.md"), "# Planning decisions\n\n### AUTH: How should sign-in work?\nAnswer: Email only\n");
    await writeDiscoveryQuestions(projectRoot, [{ ...questions[0]!, id: "UI", prompt: "Which UI style?" }]);
    const markdown = readFileSync(join(projectRoot, ".agentic", "decisions.md"), "utf8");
    expect(markdown).toContain("### AUTH: How should sign-in work?");
    expect(markdown).toContain("Answer: Email only");
    expect(markdown).toContain("### UI: Which UI style?");
  });

  it("writes deterministic digest and plan ID and reads edited draft JSON", async () => {
    const projectRoot = root();
    const first = await writePlanDraft(projectRoot, input, result, []);
    const second = await writePlanDraft(projectRoot, input, result, []);
    expect(first.planId).toBe(second.planId);
    expect(first.inputDigest).toBe(second.inputDigest);
    const draftPath = join(projectRoot, ".agentic", "plans", first.planId, "plan.json");
    const edited = JSON.parse(readFileSync(draftPath, "utf8")) as Record<string, unknown>;
    edited["summary"] = "human edit";
    writeFileSync(draftPath, JSON.stringify(edited));
    expect(await readPlanDraft(projectRoot, first.planId)).toMatchObject({ summary: "human edit" });
    await writePlanDraft(projectRoot, input, result, []);
    expect(await readPlanDraft(projectRoot, first.planId)).toMatchObject({ summary: "human edit" });
    expect(readFileSync(join(projectRoot, ".agentic", "plans", first.planId, "input.json"), "utf8")).toContain("build a todo app");
  });

  it("fills a missing plan file while preserving existing companions and extra files", async () => {
    const projectRoot = root();
    const draft = await writePlanDraft(projectRoot, input, result, []);
    const directory = join(projectRoot, ".agentic", "plans", draft.planId);
    rmSync(join(directory, "plan.json"));
    writeFileSync(join(directory, "input.json"), "user input note");
    writeFileSync(join(directory, "summary.md"), "user summary note");
    writeFileSync(join(directory, "partial.marker"), "preserve me");
    await writePlanDraft(projectRoot, input, result, []);
    expect(JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"))).toMatchObject({ planId: draft.planId });
    expect(readFileSync(join(directory, "input.json"), "utf8")).toBe("user input note");
    expect(readFileSync(join(directory, "summary.md"), "utf8")).toBe("user summary note");
    expect(readFileSync(join(directory, "partial.marker"), "utf8")).toBe("preserve me");
  });

  it("preserves an edited plan.json while repairing a missing companion file", async () => {
    const projectRoot = root();
    const draft = await writePlanDraft(projectRoot, input, result, []);
    const directory = join(projectRoot, ".agentic", "plans", draft.planId);
    const planPath = join(directory, "plan.json");
    const edited = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>;
    edited["summary"] = "human edit";
    writeFileSync(planPath, JSON.stringify(edited));
    rmSync(join(directory, "summary.md"));
    await writePlanDraft(projectRoot, input, result, []);
    expect(JSON.parse(readFileSync(planPath, "utf8"))).toMatchObject({ summary: "human edit" });
    expect(existsSync(join(directory, "summary.md"))).toBe(true);
  });
});
