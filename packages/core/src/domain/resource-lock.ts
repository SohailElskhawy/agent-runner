/**
 * Exclusive logical resource locks.
 *
 * Git and filesystem scope conflicts are not sufficient to determine safe
 * concurrency: tasks that touch different files can still logically conflict
 * because they mutate the same shared subsystem. A task declares the logical
 * resources it requires in `task.definition.resources`, and at most one task
 * may own a logical resource at any time.
 *
 * This module is the pure ownership model: it decides whether a candidate
 * can acquire its required resources given the currently held locks, and it
 * never mutates its inputs, never persists anything, never calls an agent or
 * model, and produces deterministic results for identical inputs. Persistence
 * of the lock state itself is a separate concern behind the RunnerStore port;
 * the scheduler that will consume this model must not run from here.
 *
 * Ownership identity is the (task, attempt) pair: a lock identifies the
 * resource, the owning task, and — where the caller has one — the owning
 * attempt. A task never acquires the same logical resource twice: duplicate
 * declarations collapse into one lock. Acquisition is all-or-nothing — when
 * any required resource is held by a different owner, no lock is produced.
 * Already-owned resources are idempotent no-ops, never duplicate holders.
 */

import type { AttemptId, TaskId } from "./ids.js";
import type { IsoTimestamp } from "./timestamp.js";

export type ResourceLock = {
  readonly resource: string;
  readonly taskId: TaskId;
  readonly attemptId?: AttemptId | undefined;
  readonly acquiredAt?: IsoTimestamp | undefined;
};

export type ResourceLockOwner = {
  readonly taskId: TaskId;
  readonly attemptId?: AttemptId | undefined;
};

export type ResourceLockConflict = {
  readonly resource: string;
  readonly holderTaskId: TaskId;
  readonly holderAttemptId?: AttemptId | undefined;
};

export type ResourceAcquisitionPlan =
  | {
      readonly ok: true;
      /** The deduplicated required locks, in deterministic order. */
      readonly locks: readonly ResourceLock[];
    }
  | {
      readonly ok: false;
      readonly conflicts: readonly ResourceLockConflict[];
    };

/**
 * Plans the all-or-nothing acquisition of the given resources for an owner.
 *
 * Returns every conflict when any required resource is held by a different
 * owner; in that case no locks are returned, so acquiring the plan cannot
 * leave the owner with a partial hold. When the plan succeeds, duplicate
 * resource declarations have collapsed into one lock per resource and the
 * resources are ordered ascending so lock creation order is deterministic
 * regardless of declaration order.
 */
export function planResourceAcquisition(
  owner: ResourceLockOwner,
  resources: readonly string[],
  held: readonly ResourceLock[],
): ResourceAcquisitionPlan {
  const required = requiredResourceLocks(owner, resources);
  const conflicts: ResourceLockConflict[] = [];
  const seenHolders = new Set<string>();
  for (const lock of required) {
    for (const existing of held) {
      if (existing.resource !== lock.resource) {
        continue;
      }
      if (sameOwnership(existing, owner)) {
        continue;
      }
      const holderKey = `${existing.resource}\u0000${existing.taskId}\u0000${existing.attemptId ?? ""}`;
      if (seenHolders.has(holderKey)) {
        continue;
      }
      seenHolders.add(holderKey);
      conflicts.push({
        resource: existing.resource,
        holderTaskId: existing.taskId,
        ...(existing.attemptId === undefined
          ? {}
          : { holderAttemptId: existing.attemptId }),
      });
    }
  }
  conflicts.sort(compareResourceLockConflicts);
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  return { ok: true, locks: required };
}

/**
 * The unique, ascending-ordered locks a declaration produces for an owner.
 * Duplicate declared resources collapse into a single lock, so an owner can
 * never hold the same logical resource twice.
 */
export function requiredResourceLocks(
  owner: ResourceLockOwner,
  resources: readonly string[],
): readonly ResourceLock[] {
  const locks = new Map<string, ResourceLock>();
  for (const resource of resources) {
    if (resource.length === 0 || locks.has(resource)) {
      continue;
    }
    locks.set(resource, lockFor(owner, resource));
  }
  return [...locks.values()].sort(compareResourceLocks);
}

/**
 * The subset of held locks owned by the given owner, in deterministic order.
 * Releasing exactly this subset removes every lock an attempt/task owns
 * without touching locks held by anyone else.
 */
export function resourceLocksOwnedBy(
  held: readonly ResourceLock[],
  owner: ResourceLockOwner,
): readonly ResourceLock[] {
  return held
    .filter((lock) => sameOwnership(lock, owner))
    .sort(compareResourceLocks);
}

function lockFor(owner: ResourceLockOwner, resource: string): ResourceLock {
  return {
    resource,
    taskId: owner.taskId,
    ...(owner.attemptId === undefined ? {} : { attemptId: owner.attemptId }),
  };
}

function sameOwnership(
  lock: ResourceLock,
  owner: ResourceLockOwner,
): boolean {
  return lock.taskId === owner.taskId && lock.attemptId === owner.attemptId;
}

function compareResourceLocks(
  left: ResourceLock,
  right: ResourceLock,
): number {
  return compareStrings(left.resource, right.resource);
}

function compareResourceLockConflicts(
  left: ResourceLockConflict,
  right: ResourceLockConflict,
): number {
  const resourceDelta = compareStrings(left.resource, right.resource);
  if (resourceDelta !== 0) {
    return resourceDelta;
  }
  const holderDelta = compareStrings(left.holderTaskId, right.holderTaskId);
  if (holderDelta !== 0) {
    return holderDelta;
  }
  return compareStrings(left.holderAttemptId ?? "", right.holderAttemptId ?? "");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
