/**
 * Deterministic local integration queue.
 *
 * Concurrent implementation work may happen, but Git integration into the
 * canonical integration branch is runner-controlled and serialized: before a
 * successfully prepared task attempt may integrate, it enters this queue, and
 * at most one queued entry is ever actively integrating at a time.
 *
 * The queue is a durable FIFO with one deterministic ordering policy:
 *
 *   1. durable enqueue sequence ascending (the order entries were persisted)
 *   2. queue entry id ascending as the final deterministic tie-breaker
 *
 * No priority scheduling, aging, or adaptive policy exists inside the
 * integration queue. Entries are immutable history: completing or failing an
 * entry records its outcome; entries are never deleted, so every integration
 * request remains inspectable. A (task, attempt) pair may appear only once
 * among the active entries (PENDING or INTEGRATING); completed or failed
 * entries do not block a later re-enqueue of the same pair.
 *
 * This module is the pure queue policy: it orders entries, detects active
 * duplicates, and selects the next claimable entry. It never mutates its
 * inputs, never persists anything, never runs Git, and never calls an agent.
 * Durable queue state lives behind the RunnerStore port; the claim must be
 * atomic under SQLite concurrency and is the store's responsibility, not
 * this module's.
 */

import type { AttemptId, TaskId } from "./ids.js";
import type { IsoTimestamp } from "./timestamp.js";

export const INTEGRATION_QUEUE_STATUSES = [
  "PENDING",
  "INTEGRATING",
  "COMPLETED",
  "FAILED",
] as const;

export type IntegrationQueueStatus = (typeof INTEGRATION_QUEUE_STATUSES)[number];

export const ACTIVE_INTEGRATION_QUEUE_STATUSES = [
  "PENDING",
  "INTEGRATING",
] as const;

export type ActiveIntegrationQueueStatus = Exclude<
  IntegrationQueueStatus,
  "COMPLETED" | "FAILED"
>;

export type IntegrationQueueEntry = {
  /** Durable queue identity, assigned when the entry is persisted. */
  readonly id: string;
  /**
   * Durable enqueue sequence assigned by the persistence layer. Queue order
   * is `sequence` ascending with `id` ascending as the tie-breaker.
   */
  readonly sequence: number;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  /** The prepared task commit/revision this entry integrates. */
  readonly taskRevision: string;
  /** The isolated task branch the runner integrates through. */
  readonly branch: string;
  /** The attempt's implementation base revision, kept for drift evidence. */
  readonly baseRevision: string;
  readonly status: IntegrationQueueStatus;
  readonly enqueuedAt: IsoTimestamp;
  readonly claimedAt?: IsoTimestamp | undefined;
  /** Terminal time of the entry: when it completed or failed. */
  readonly finishedAt?: IsoTimestamp | undefined;
  readonly failure?: { readonly message: string } | undefined;
};

export type IntegrationQueueRequest = {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly taskRevision: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly enqueuedAt: IsoTimestamp;
  /**
   * Optional durable identity. When omitted, the persistence layer assigns
   * one; when supplied it must be unique across the queue history.
   */
  readonly id?: string | undefined;
};

export type IntegrationQueueOrdering = {
  readonly entries: readonly IntegrationQueueEntry[];
  readonly requested: readonly IntegrationQueueRequest[];
};

/**
 * Orders queue entries with the canonical queue policy: enqueue sequence
 * ascending, then entry id ascending. Identical inputs always produce an
 * identical order regardless of input order.
 */
export function orderIntegrationQueueEntries(
  entries: readonly IntegrationQueueEntry[],
): readonly IntegrationQueueEntry[] {
  return [...entries].sort(compareIntegrationQueueEntries);
}

function compareIntegrationQueueEntries(
  left: IntegrationQueueEntry,
  right: IntegrationQueueEntry,
): number {
  const sequenceDelta = left.sequence - right.sequence;
  if (sequenceDelta !== 0) {
    return sequenceDelta;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

/**
 * The active (PENDING or INTEGRATING) entry for the given task/attempt pair,
 * if any. Enqueueing while this returns an entry would create an active
 * duplicate and must be rejected deterministically.
 */
export function findActiveIntegrationQueueEntry(
  entries: readonly IntegrationQueueEntry[],
  taskId: TaskId,
  attemptId: AttemptId,
): IntegrationQueueEntry | undefined {
  return entries.find(
    (entry) =>
      entry.taskId === taskId &&
      entry.attemptId === attemptId &&
      isActiveIntegrationQueueStatus(entry.status),
  );
}

/**
 * Whether the given task/attempt pair already has an active queue entry.
 */
export function hasActiveIntegrationQueueEntry(
  entries: readonly IntegrationQueueEntry[],
  taskId: TaskId,
  attemptId: AttemptId,
): boolean {
  return findActiveIntegrationQueueEntry(entries, taskId, attemptId) !== undefined;
}

export function isActiveIntegrationQueueStatus(
  status: IntegrationQueueStatus,
): status is ActiveIntegrationQueueStatus {
  return status === "PENDING" || status === "INTEGRATING";
}

export type NextIntegrationQueueEntrySelection =
  | { readonly ok: true; readonly entry: IntegrationQueueEntry }
  | {
      readonly ok: false;
      readonly reason: "entry-integrating" | "queue-empty";
    };

/**
 * Selects the next entry to integrate deterministically, or explains why
 * none may be claimed. At most one entry may be actively integrating: while
 * any entry is INTEGRATING, no selection happens, even when PENDING entries
 * exist. Otherwise the first PENDING entry in canonical queue order is
 * selected. This pure selection mirrors what an atomic store claim must
 * enforce; it never claims by itself.
 */
export function selectNextIntegrationQueueEntry(
  entries: readonly IntegrationQueueEntry[],
): NextIntegrationQueueEntrySelection {
  const ordered = orderIntegrationQueueEntries(entries);
  for (const entry of ordered) {
    if (entry.status === "INTEGRATING") {
      return { ok: false, reason: "entry-integrating" };
    }
  }
  const next = ordered.find((entry) => entry.status === "PENDING");
  return next === undefined
    ? { ok: false, reason: "queue-empty" }
    : { ok: true, entry: next };
}
