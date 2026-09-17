/**
 * Deterministic parallelism capacity policy.
 *
 * The pure capacity primitive that decides whether another task may start
 * given the configured maximum parallelism and the currently active task
 * executions. This is capacity policy only: it never starts tasks, never
 * mutates tasks or attempts, never touches persistence, never acquires
 * resource locks, never runs conflict detection, and never executes the
 * scheduler.
 *
 * Active execution counting is explicit. A task/attempt execution is active
 * — and consumes one execution slot — while its authoritative workflow
 * status is one of:
 *
 *   PLANNING, PLAN_REVIEW, IMPLEMENTING, CODE_REVIEW, VERIFYING, INTEGRATING
 *
 * Capacity policy covers active task workflows including INTEGRATING. Once
 * integration is serialized by the integration queue (M047a), at most one
 * task integrates at any time, so integration consumes an ordinary
 * execution slot instead of a separate integration-capacity pool: there is
 * no architectural reason to size integration capacity independently, and
 * one shared policy keeps "how many tasks may run" answerable from a single
 * number. BACKLOG, READY, DONE, BLOCKED, NEEDS_HUMAN, FAILED, and CANCELLED
 * consume no execution slot.
 *
 * The configured maximum must be a positive integer. Invalid values are
 * rejected deterministically — zero, negative, non-integer, and
 * non-numeric values are never silently normalized. Evaluation is pure and
 * deterministic: identical inputs always produce identical decisions, and
 * repeated evaluation of unchanged inputs never flips.
 *
 * An execution count above the maximum is treated as an overcommitted
 * state, not a crash: the decision fails safe to "exhausted" with no
 * remaining slots.
 */

import type { TaskStatus } from "./task-status.js";

/**
 * Every canonical workflow status that represents an active execution and
 * consumes one parallelism slot.
 */
export const PARALLELISM_ACTIVE_STATUSES = [
  "PLANNING",
  "PLAN_REVIEW",
  "IMPLEMENTING",
  "CODE_REVIEW",
  "VERIFYING",
  "INTEGRATING",
] as const;

export type ParallelismActiveStatus = (typeof PARALLELISM_ACTIVE_STATUSES)[number];

export const PARALLELISM_CAPACITY_STATUSES = [
  "available",
  "exhausted",
] as const;

export type ParallelismCapacityStatus = (typeof PARALLELISM_CAPACITY_STATUSES)[number];

export type ParallelismCapacityDecision = {
  /** Whether another task execution may start. */
  readonly status: ParallelismCapacityStatus;
  readonly maxParallelism: number;
  readonly activeExecutions: number;
  /**
   * Execution slots still free, floored at zero when the observed active
   * count already exceeds the configured maximum.
   */
  readonly remainingSlots: number;
};

export class ParallelismCapacityError extends Error {
  readonly value: unknown;

  constructor(message: string, value: unknown) {
    super(message);
    this.name = "ParallelismCapacityError";
    this.value = value;
  }
}

/**
 * Whether a task workflow status represents an active execution that
 * consumes a parallelism slot.
 */
export function isParallelismActiveStatus(
  status: TaskStatus,
): status is ParallelismActiveStatus {
  return (PARALLELISM_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * The explicit count of active executions among the given statuses. Every
 * authoritative active workflow status counts exactly once; inactive
 * statuses (BLOCKED, FAILED, CANCELLED, DONE, READY, BACKLOG,
 * NEEDS_HUMAN) never count.
 */
export function countParallelismActiveExecutions(
  statuses: readonly TaskStatus[],
): number {
  let count = 0;
  for (const status of statuses) {
    if (isParallelismActiveStatus(status)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Decides deterministically whether another task execution may start.
 *
 * Throws `ParallelismCapacityError` when `maxParallelism` is not a positive
 * integer. Negative or overcommitted active counts do not throw: they fail
 * safe to an "exhausted" decision with zero remaining slots.
 */
export function evaluateParallelismCapacity(input: {
  maxParallelism: number;
  activeExecutions: number;
}): ParallelismCapacityDecision {
  const maxParallelism = input.maxParallelism;
  if (
    typeof maxParallelism !== "number" ||
    !Number.isInteger(maxParallelism) ||
    maxParallelism <= 0
  ) {
    throw new ParallelismCapacityError(
      "maxParallelism must be a positive integer; invalid values are not normalized",
      maxParallelism,
    );
  }
  const activeExecutions = input.activeExecutions;
  if (
    typeof activeExecutions !== "number" ||
    !Number.isInteger(activeExecutions) ||
    activeExecutions < 0
  ) {
    throw new ParallelismCapacityError(
      "activeExecutions must be a non-negative integer",
      activeExecutions,
    );
  }
  const remainingSlots = Math.max(0, maxParallelism - activeExecutions);
  return {
    status: remainingSlots > 0 ? "available" : "exhausted",
    maxParallelism,
    activeExecutions,
    remainingSlots,
  };
}
