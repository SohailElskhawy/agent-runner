import type { PlanningQuestion } from "@agentic-dev-runner/core";
import type { PlanPreview } from "../application/ports.js";
import type { CliIo } from "../io.js";

export function renderQuestions(io: CliIo, questions: readonly PlanningQuestion[]): void {
  io.writeLine("planning status: NEEDS_DISCOVERY");
  io.writeLine("Answer these questions in .agentic/decisions.md, then run agentic plan --goal again:");
  for (const question of questions) {
    io.writeLine(`  ${question.id}: ${question.prompt}`);
    io.writeLine(`    why: ${question.reason}`);
    io.writeLine(`    choices: ${question.choices.join(" | ")}`);
    io.writeLine(`    importance: ${question.importance}`);
  }
}

export function renderPlan(io: CliIo, plan: PlanPreview): void {
  io.writeLine(`plan: ${plan.planId}`);
  io.writeLine(`input digest: ${plan.inputDigest}`);
  io.writeLine(plan.summary.trim());
  io.writeLine(`parallelizable: ${String(plan.parallelizableTaskCount)}`);
  io.writeLine(`approval gates: ${String(plan.tasks.filter((task) => task.approvalRequired).length)}`);
  for (const task of plan.tasks) {
    io.writeLine(`  ${task.id} [${task.milestone}] ${task.title}`);
    if (task.dependsOn.length) io.writeLine(`    depends on: ${task.dependsOn.join(", ")}`);
    io.writeLine(`    risk: ${task.risk}`);
    io.writeLine(`    objective: ${task.objective}`);
    io.writeLine(`    acceptance: ${task.acceptanceCriteria.join("; ")}`);
    io.writeLine(`    scope: ${task.allowedPaths.join(", ") || "none declared"}`);
    if (task.approvalRequired) io.writeLine("    approval: required");
  }
  for (const conflict of plan.conflicts) {
    io.writeLine(`warning: scheduling conflict: ${conflict.taskIdA} / ${conflict.taskIdB} (${conflict.kind})`);
    if (conflict.kind === "resource") io.writeLine(`  shared resources: ${conflict.resources.join(", ")}`);
    else for (const overlap of conflict.patterns) io.writeLine(`  ${overlap.patternA} overlaps ${overlap.patternB}`);
    io.writeLine("  the scheduler will serialize these tasks");
  }
  if (plan.approvalStatus === "draft") io.writeLine("This draft is not executable. Review it, then approve it explicitly.");
  else if (plan.approvalStatus === "approved") io.writeLine("This plan is approved; its tasks are in runner state.");
  else io.writeLine("This plan was approved earlier, but the draft changed; this preview isn't the imported task set.");
  if (plan.approvalStatus === "changed") io.writeLine("Inspect the imported tasks with agentic tasks before acting on this edited draft.");
}
