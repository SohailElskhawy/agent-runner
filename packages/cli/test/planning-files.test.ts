import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("preserves a current answer's complete raw block and old question details", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    const block = "### AUTH: old wording\nWhy: old reason\nChoices: old choices\nAnswer: Email\n  second paragraph\n  ### not a question\n\n";
    writeFileSync(path, `# Decisions\n\n${block}`);
    await writeDiscoveryQuestions(projectRoot, questions);
    expect(readFileSync(path, "utf8")).toBe(`# Planning decisions\n\nContinue multi-line answers on lines indented by two spaces.\n\n${block}`);
  });

  it("preserves Question ID-only files, broad heading IDs and empty prompts", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    const blocks = "Question ID: AUTH\nAnswer: yes\n\n### _x:\nAnswer: x\n\n### café: \nAnswer: coffee\n";
    writeFileSync(path, blocks);
    await writeDiscoveryQuestions(projectRoot, questions);
    expect(readFileSync(path, "utf8")).toBe(`# Planning decisions\n\nContinue multi-line answers on lines indented by two spaces.\n\n### _x:\nAnswer: x\n\n### café: \nAnswer: coffee\nQuestion ID: AUTH\nAnswer: yes\n\n`);
  });

  it("uses the writer ID when it differs from the legacy reader ID", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    const block = "## id-é: old\nAnswer: preserved\n";
    writeFileSync(path, block);
    await writeDiscoveryQuestions(projectRoot, [{ ...questions[0]!, id: "id" }]);
    expect(readFileSync(path, "utf8")).toContain(`${block}### id: How should sign-in work?`);
  });

  it("retains CRLF and blank lines without growth across two regenerations", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    const block = "### OLD: question\r\nAnswer: first\r\n  second\r\n\r\n\r\n";
    writeFileSync(path, block);
    await writeDiscoveryQuestions(projectRoot, questions);
    const first = readFileSync(path, "utf8");
    expect(first).toContain(block);
    await writeDiscoveryQuestions(projectRoot, questions);
    expect(readFileSync(path, "utf8")).toBe(first);
    await writeDiscoveryQuestions(projectRoot, questions);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("orders old winning blocks by their positions, then current questions in request order", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    writeFileSync(path, "### OLD1: first\nAnswer: old\n### AUTH: old auth\nAnswer: auth\n### OLD2: second\nAnswer: two\n### OLD1: winner\nAnswer: new\n### UI: old ui\nAnswer: ui");
    await writeDiscoveryQuestions(projectRoot, [{ ...questions[0]!, id: "UI" }, questions[0]!]);
    expect(readFileSync(path, "utf8")).toBe("# Planning decisions\n\nContinue multi-line answers on lines indented by two spaces.\n\n### OLD2: second\nAnswer: two\n### OLD1: winner\nAnswer: new\n### UI: old ui\nAnswer: ui\n### AUTH: old auth\nAnswer: auth\n");
  });

  it("keeps the last nonempty duplicate's block even if a later duplicate is empty", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    const winner = "### OLD: winner\nAnswer: kept\n";
    writeFileSync(path, `### OLD: first\nAnswer: earlier\n${winner}### OLD: empty\nAnswer:\n`);
    await writeDiscoveryQuestions(projectRoot, []);
    expect(readFileSync(path, "utf8")).toBe(`# Planning decisions\n\nContinue multi-line answers on lines indented by two spaces.\n\n${winner}`);
  });

  it("preserves an empty-first, later-nonempty block including an indented marker and hint-like line", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    const block = "### AUTH: old\nAnswer:\nNote: later answer follows\nAnswer: yes\n  Question ID: not-a-marker\n  Continue multi-line answers on lines indented by two spaces.\n";
    writeFileSync(path, block);
    await writeDiscoveryQuestions(projectRoot, questions);
    expect(readFileSync(path, "utf8")).toBe(`# Planning decisions\n\nContinue multi-line answers on lines indented by two spaces.\n\n${block}`);
  });

  it("writes stable question-ID headings and preserves existing answers", async () => {
    const projectRoot = root();
    await writeDiscoveryQuestions(projectRoot, questions);
    writeFileSync(join(projectRoot, ".agentic", "decisions.md"), "# Decisions\n\n### AUTH: old wording\nAnswer: Email only\n");
    await writeDiscoveryQuestions(projectRoot, questions);
    const markdown = readFileSync(join(projectRoot, ".agentic", "decisions.md"), "utf8");
    expect(markdown).toContain("### AUTH: old wording");
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

  it("emits a duplicate question ID's block only once, answered and unanswered", async () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, ".agentic"));
    const path = join(projectRoot, ".agentic", "decisions.md");
    // answered: duplicate ID backed by a preserved block
    writeFileSync(path, "### DUP: old wording\nAnswer: preserved\n");
    await writeDiscoveryQuestions(projectRoot, [{ ...questions[0]!, id: "DUP" }, { ...questions[0]!, id: "DUP" }]);
    expect(readFileSync(path, "utf8").split("### DUP: old wording").length - 1).toBe(1);
    // unanswered: duplicate ID with no preserved block, alongside another question
    await writeDiscoveryQuestions(projectRoot, [{ ...questions[0]!, id: "NEW" }, { ...questions[0]!, id: "NEW" }]);
    const markdown = readFileSync(path, "utf8");
    expect(markdown.split("### NEW:").length - 1).toBe(1);
    expect(markdown).toContain("### DUP: old wording");
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
