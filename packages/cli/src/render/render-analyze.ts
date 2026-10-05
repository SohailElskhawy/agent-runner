import type { PlanningInput } from "@agentic-dev-runner/core";
import type { CliIo } from "../io.js";

export function renderAnalysis(io: CliIo, input: PlanningInput): void {
  io.writeLine("repository analysis:");
  io.writeLine(`  root: ${input.repositoryRoot}`);
  io.writeLine(`  base revision: ${input.baseRevision}`);
  if (input.goal) io.writeLine(`  goal: ${input.goal}`);
  const state = input.repositoryEvidence.find((item) => item.path === ".agentic/analysis-status.txt");
  if (state?.status === "present") {
    const workingTree = /^workingTree: (.+)$/m.exec(state.content)?.[1];
    if (workingTree !== undefined) io.writeLine(`  working tree: ${workingTree}`);
  }
  const absent = input.repositoryEvidence.filter((item) => item.status === "absent");
  const presentCount = input.repositoryEvidence.filter((item) => item.status === "present").length;
  io.writeLine(`  bounded evidence: ${String(presentCount)} present, ${String(absent.length)} absent`);
  for (const item of absent) io.writeLine(`  absent: ${item.path}`);
  io.writeLine(`  recorded decisions: ${String(input.knownDecisions.length)}`);
  io.writeLine(`  readiness: ${input.goal.trim() ? "analysis complete; planning readiness is assessed during plan generation" : "not assessed; provide a goal with agentic plan --goal <text>"}`);
}
