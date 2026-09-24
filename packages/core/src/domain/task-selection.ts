/**
 * Deterministic runnable-task selection.
 *
 * A scheduling primitive that evaluates a collection of persisted tasks and
 * decides which of them are currently runnable. A task is runnable when all
 * of the canonical conditions hold:

 *   status == READY
 *   AND every `depends_on` task is DONE
 *   AND human approval requirements are satisfied
 *   AND the attempt budget (`limits.maxAttempts`) is not exhausted
 *   AND an eligible agent exists for the task's required capabilities
 *
 * Selection is pure and deterministic: it never mutates tasks, never invokes
 * agents or adapters, never touches persistence, and applies no scheduling
 * priority. The persisted attempt count per task and the agent routing
 * candidates (profiles plus externally discovered adapter availability) are
 * inputs, exactly like the approved routing primitive consumes them; a task
 * is eligible when the same `selectAgentProfile` rules select one of the
 * supplied candidates.
 *
 * Conditions are evaluated in the canonical order above and the first
 * unsatisfied condition determines the reported ineligibility. A dependency
 * that is absent from the evaluated collection is treated as not DONE, so
 * partially loaded collections can never mark a task runnable by omission.
 * Resource availability and parallelism capacity are later scheduler
 * concerns and are deliberately absent here.
 */

import type { TaskId } from "./ids.js";
import type { TaskStatus } from "./task-status.js";
import type { Task } from "./task.js";
import type { AgentRouteCandidate, AgentRouteRejection } from "./agent-router.js";
import { selectAgentProfile } from "./agent-router.js";

export const TASK_INELIGIBILITY_REASONS = [
  "not-ready",
  "dependency-not-done",
  "approval-required",
  "attempt-limit-exhausted",
  "no-eligible-agent",
] as const;

export type TaskIneligibilityReason =
  (typeof TASK_INELIGIBILITY_REASONS)[number];

/**
 * The unsatisfied runnable condition of one task, evaluated in the canonical
 * condition order so identical inputs always produce identical results.
 */
export type TaskIneligibility =
  | {
      readonly reason: "not-ready";
      readonly status: TaskStatus;
    }
  | {
      readonly reason: "dependency-not-done";
      readonly notDoneDependencies: readonly TaskId[];
    }
  | { readonly reason: "approval-required" }
  | {
      readonly reason: "attempt-limit-exhausted";
      readonly attempts: number;
      readonly maxAttempts: number;
    }
  | {
      readonly reason: "no-eligible-agent";
      readonly rejections: readonly AgentRouteRejection[];
    };

export type IneligibleTask = {
  readonly taskId: TaskId;
  readonly ineligibility: TaskIneligibility;
};

export type RunnableTaskSelection = {
  /** The runnable tasks, in the order they appeared in the input. */
  readonly runnable: readonly Task[];
  /** The non-runnable tasks with their deterministic ineligibility, in input order. */
  readonly ineligible: readonly IneligibleTask[];
};

export type RunnableTaskSelectionInput = {
  readonly tasks: readonly Task[];
  /**
   * The persisted attempt count per task id. A missing entry means the task
   * has no attempts yet; counting is the caller's responsibility because
   * this selection never reads persistence.
   */
  readonly attemptCounts: ReadonlyMap<TaskId, number>;
  /**
   * Agent routing candidates: each profile joined with its externally
   * discovered adapter availability, in the caller's deterministic order.
   */
  readonly agentCandidates: readonly AgentRouteCandidate[];
};

export function selectRunnableTasks(
  input: RunnableTaskSelectionInput,
): RunnableTaskSelection {
  const tasksById = new Map<TaskId, Task>();
  for (const task of input.tasks) {
    if (!tasksById.has(task.id)) {
      tasksById.set(task.id, task);
    }
  }
  const runnable: Task[] = [];
  const ineligible: IneligibleTask[] = [];
  for (const task of input.tasks) {
    const ineligibility = firstIneligibilityOf(task, input, tasksById);
    if (ineligibility === undefined) {
      runnable.push(task);
    } else {
      ineligible.push({ taskId: task.id, ineligibility });
    }
  }
  return { runnable, ineligible };
}

function firstIneligibilityOf(
  task: Task,
  input: RunnableTaskSelectionInput,
  tasksById: ReadonlyMap<TaskId, Task>,
): TaskIneligibility | undefined {
  if (task.status !== "READY") {
    return { reason: "not-ready", status: task.status };
  }
  const notDoneDependencies = notDoneDependenciesOf(task, tasksById);
  if (notDoneDependencies.length > 0) {
    return { reason: "dependency-not-done", notDoneDependencies };
  }
  if (
    task.definition.approval.required &&
    task.approvalGrantedAt === undefined
  ) {
    return { reason: "approval-required" };
  }
  const attempts = input.attemptCounts.get(task.id) ?? 0;
  const maxAttempts = task.definition.limits.maxAttempts;
  if (attempts >= maxAttempts) {
    return { reason: "attempt-limit-exhausted", attempts, maxAttempts };
  }
  const route = selectAgentProfile({
    requiredCapabilities: task.routing.capabilities,
    candidates: input.agentCandidates,
  });
  if (!route.selected) {
    return { reason: "no-eligible-agent", rejections: route.rejections };
  }
  return undefined;
}

/**
 * The task's dependencies that have not reached DONE, in `depends_on` order.
 * A dependency missing from the evaluated collection counts as not done.
 */
function notDoneDependenciesOf(
  task: Task,
  tasksById: ReadonlyMap<TaskId, Task>,
): TaskId[] {
  const notDone: TaskId[] = [];
  for (const dependencyId of task.dependsOn) {
    const dependency = tasksById.get(dependencyId);
    if (dependency?.status !== "DONE") {
      notDone.push(dependencyId);
    }
  }
  return notDone;
}
