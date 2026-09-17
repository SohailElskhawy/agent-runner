/**
 * Deterministic scheduling priority for runnable tasks.
 *
 * Given the runnable tasks produced by the runnable-task selection, this
 * pure ordering primitive produces the stable execution ordering the
 * scheduler starts tasks in:
 *
 *   1. canonical task priority ascending (P0 before P1, ...)
 *   2. stable task id ascending as the final deterministic tie-breaker
 *
 * The canonical documents define no risk- or complexity-based scheduling
 * precedence, so none is applied. Ordering is a total order over the
 * supplied tasks: identical inputs always produce identical output
 * regardless of input order, repeated invocation is identical, no agent or
 * model is called, nothing is persisted, no historical or adaptive policy
 * exists, and the input collection and its tasks are never mutated.
 * Routing (which agent executes a task) and parallelism capacity are
 * separate concerns and are deliberately absent here.
 */

import type { Task } from "./task.js";

export function orderRunnableTasks(
  tasks: readonly Task[],
): readonly Task[] {
  return [...tasks].sort(compareTasksForExecution);
}

function compareTasksForExecution(a: Task, b: Task): number {
  const priorityDelta = priorityRankOf(a.priority) - priorityRankOf(b.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

/**
 * Numeric rank of a canonical `P<n>` task priority. A priority that does not
 * carry a numeric suffix ranks after every ranked priority, deterministically.
 */
function priorityRankOf(priority: Task["priority"]): number {
  const rank = Number.parseInt(priority.slice(1), 10);
  return Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER;
}
