import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManualTaskInput, PlanningInput, PlanningQuestion, PlanningResult } from "@agentic-dev-runner/core";

export type PlanDraft = {
  readonly version: 1;
  readonly planId: string;
  readonly inputDigest: string;
  readonly input: PlanningInput;
  readonly result: PlanningResult;
  readonly tasks: readonly ManualTaskInput[];
  readonly summary: string;
};

export async function writeDiscoveryQuestions(projectRoot: string, questions: readonly PlanningQuestion[]): Promise<void> {
  const path = join(projectRoot, ".agentic", "decisions.md");
  const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const answers = new Map<string, string>();
  const answeredBlocks = new Map<string, string[]>();
  let id: string | undefined;
  let block: string[] = [];
  for (const line of previous.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+([^\s:]+)\s*(?::|—|-)\s*/.exec(line);
    if (heading?.[1] !== undefined) {
      if (id !== undefined && answers.has(id)) answeredBlocks.set(id, block);
      id = heading[1];
      block = [line];
    } else if (id !== undefined) {
      block.push(line);
    }
    const answer = /^\s*Answer:\s*(.*)$/.exec(line);
    if (answer !== null && id !== undefined) {
      if (answer[1]?.trim()) answers.set(id, answer[1].trim());
    }
  }
  if (id !== undefined && answers.has(id)) answeredBlocks.set(id, block);
  const currentIds = new Set(questions.map((question) => question.id));
  const previousDecisions = [...answeredBlocks]
    .filter(([questionId]) => !currentIds.has(questionId))
    .flatMap(([, lines]) => [...lines, ""]);
  const lines = ["# Planning decisions", "", ...previousDecisions, ...questions.flatMap((question) => [
    `### ${question.id}: ${question.prompt.replace(/[\r\n]+/g, " ")}`,
    `Why: ${question.reason.replace(/[\r\n]+/g, " ")}`,
    `Choices: ${question.choices.map((choice) => choice.replace(/[\r\n]+/g, " ")).join(" | ")}`,
    `Answer: ${answers.get(question.id) ?? ""}`,
    "",
  ])];
  await mkdir(join(projectRoot, ".agentic"), { recursive: true });
  const temporaryPath = join(projectRoot, ".agentic", `decisions.${randomUUID()}.tmp`);
  let written = false;
  try {
    await writeFile(temporaryPath, lines.join("\n"), { encoding: "utf8", flag: "wx" });
    written = true;
    await rename(temporaryPath, path);
  } catch (error) {
    if (written || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function writePlanDraft(
  projectRoot: string,
  input: PlanningInput,
  result: PlanningResult,
  tasks: readonly ManualTaskInput[],
): Promise<Pick<PlanDraft, "planId" | "inputDigest">> {
  const inputDigest = digest(stableJson(input));
  const planId = `plan-${digest(stableJson({ input, result })).slice(0, 16)}`;
  const summary = [
    `# ${input.goal}`, "",
    ...result.kind === "READY_FOR_PLANNING" ? result.milestones.flatMap((milestone) => [
      `## ${milestone.title}`, ...milestone.completionCriteria.map((criterion) => `- ${criterion}`),
      ...tasks.filter((task) => task.milestone === milestone.id).map((task) => `- ${task.id}: ${task.title}`), "",
    ]) : [],
  ].join("\n");
  const plansDirectory = join(projectRoot, ".agentic", "plans");
  const directory = join(plansDirectory, planId);
  await mkdir(plansDirectory, { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const planPath = join(directory, "plan.json");
    const existingPlan = await readFile(planPath, "utf8").catch(() => null);
    if (existingPlan !== null) {
      await createIfMissing(join(directory, "input.json"), `${stableJson(input)}\n`);
      await createIfMissing(join(directory, "summary.md"), summary);
      return { planId, inputDigest };
    }
    await Promise.all([
      createIfMissing(join(directory, "input.json"), `${stableJson(input)}\n`),
      createIfMissing(join(directory, "summary.md"), summary),
      createIfMissing(planPath, `${stableJson({ version: 1, planId, inputDigest, input, result, tasks, summary })}\n`),
    ]);
    return { planId, inputDigest };
  }
  try {
    await Promise.all([
      writeFile(join(directory, "input.json"), `${stableJson(input)}\n`, "utf8"),
      writeFile(join(directory, "plan.json"), `${stableJson({ version: 1, planId, inputDigest, input, result, tasks, summary })}\n`, "utf8"),
      writeFile(join(directory, "summary.md"), summary, "utf8"),
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { planId, inputDigest };
}

async function createIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function readPlanDraft(projectRoot: string, planId: string): Promise<unknown> {
  if (!/^plan-[a-f0-9]{16}$/.test(planId)) throw new Error(`invalid plan ID "${planId}"`);
  return JSON.parse(await readFile(join(projectRoot, ".agentic", "plans", planId, "plan.json"), "utf8")) as unknown;
}

export async function removePlanDraft(projectRoot: string, planId: string): Promise<void> {
  await rm(join(projectRoot, ".agentic", "plans", planId), { recursive: true, force: true });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
