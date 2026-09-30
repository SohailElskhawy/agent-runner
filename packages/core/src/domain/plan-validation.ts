import type { PlanningResult } from "./planning-result.js";
import { normalizePlannedTask } from "./planned-task.js";
import { buildTaskFromManualInput, validateManualTaskInput, type ManualTaskInput } from "./task-ingestion.js";
import { detectTaskConflicts, type TaskConflict } from "./task-conflicts.js";

export type PlanValidationOptions = {
  readonly configuredVerificationChecks: readonly string[];
  readonly existingTaskIds?: readonly string[];
};

export type PlanValidationResult =
  | { readonly ok: true; readonly tasks: readonly ManualTaskInput[]; readonly conflicts: readonly TaskConflict[] }
  | { readonly ok: false; readonly issues: readonly string[] };

export function normalizeAndValidatePlan(
  result: PlanningResult,
  options: PlanValidationOptions,
): PlanValidationResult {
  if (result.kind !== "READY_FOR_PLANNING") {
    return { ok: false, issues: ["plan: result must be READY_FOR_PLANNING"] };
  }

  const issues: string[] = [];
  const milestoneOrder = new Map<string, number>();
  result.milestones.forEach((milestone, index) => {
    if (milestoneOrder.has(milestone.id)) issues.push(`plan milestone: duplicate id "${milestone.id}"`);
    milestoneOrder.set(milestone.id, index);
  });

  const existingIds = new Set(options.existingTaskIds ?? []);
  const seenIds = new Set<string>();
  const tasks: ManualTaskInput[] = [];

  result.tasks.forEach((rawTask, index) => {
    const path = `plan.tasks[${index}]`;
    const id = rawTask["id"];
    const milestone = rawTask["milestone"];
    if (typeof id === "string") {
      if (seenIds.has(id)) issues.push(`${path}.id: duplicate task id "${id}"`);
      if (existingIds.has(id)) issues.push(`${path}.id: task id "${id}" already exists`);
      seenIds.add(id);
    }
    if (typeof milestone === "string" && !milestoneOrder.has(milestone)) {
      issues.push(`${path}.milestone: references unknown milestone "${milestone}"`);
    }

    const normalized = normalizePlannedTask(rawTask, milestoneOrder.get(String(milestone)), path, issues);
    collectPlanConstraintIssues(rawTask, path, options.configuredVerificationChecks, issues);
    const validated = validateManualTaskInput(normalized);
    if (!validated.ok) {
      issues.push(...validated.issues.map((issue) => `${path}: ${issue}`));
    } else {
      const task = validated.value;
      tasks.push(task);
    }
  });

  for (const milestone of result.milestones) {
    if (!tasks.some((task) => task.milestone === milestone.id)) {
      issues.push(`plan milestone "${milestone.id}": has no tasks`);
    }
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency) && !existingIds.has(dependency)) {
        issues.push(`plan task "${task.id}": dependency "${dependency}" does not exist`);
      }
    }
  }
  if (hasCycle(tasks)) issues.push("plan tasks: dependencies contain a cycle");

  if (issues.length) return { ok: false, issues };
  const conflicts = detectTaskConflicts(tasks.map((task) => buildTaskFromManualInput(task, {
    projectId: "planning",
    now: "1970-01-01T00:00:00.000Z",
  })));
  return { ok: true, tasks, conflicts };
}

function collectPlanConstraintIssues(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  configuredChecks: readonly string[],
  issues: string[],
): void {
  const routing = raw["routing"];
  if (isRecord(routing) && routing["complexity"] === "large") {
    issues.push(`${path}.routing.complexity: must be medium or smaller`);
  }
  if (Array.isArray(raw["acceptanceCriteria"]) && raw["acceptanceCriteria"].length > 5) {
    issues.push(`${path}.acceptanceCriteria: must contain at most 5 criteria`);
  }
  if (Array.isArray(raw["allowedPaths"]) && raw["allowedPaths"].length > 8) {
    issues.push(`${path}.allowedPaths: must contain at most 8 paths`);
  }
  if (Array.isArray(raw["verification"])) {
    for (const check of raw["verification"]) {
      if (typeof check === "string" && !configuredChecks.includes(check)) {
        issues.push(`${path}.verification: check "${check}" is not configured`);
      }
    }
  }
}

function hasCycle(tasks: readonly ManualTaskInput[]): boolean {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn.filter((id) => tasks.some((candidate) => candidate.id === id))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
