/**
 * Deterministic preflight conflict detection for concurrent tasks.
 *
 * Before two otherwise-runnable tasks may execute concurrently, the runner
 * must know whether they are safe together. Two tasks conflict when either:
 *
 *   1. they require an overlapping exclusive logical resource (declared in
 *      `task.definition.resources`), or
 *   2. their allowed modification scopes (`task.definition.scope
 *      .allowedPaths`) can both claim the same repository path.
 *
 * Path overlap is decided conservatively over the glob semantics supported
 * by task scope contracts: two patterns conflict when some repository path
 * can match both. Parent and nested child scopes overlap, identical and
 * sibling-incomparable wildcard scopes overlap, and patterns are only
 * reported disjoint when their fixed path prefixes provably cannot reach the
 * same path. When safety cannot be proven, the tasks conflict. Forbidden
 * paths grant no writable scope and never create path conflicts on their
 * own.
 *
 * The detector is pure: no Git mutation, no lock acquisition, no task
 * mutation, no scheduling, no agent or model calls. Identical inputs always
 * produce identical conflicts in identical order regardless of input
 * ordering; every candidate pair is evaluated with its task ids in
 * ascending order and diagnostics are sorted deterministically.
 */

import type { TaskId } from "./ids.js";
import type { TaskScope } from "./task-contract.js";
import type { Task } from "./task.js";

export type TaskConflictKind = "resource" | "path";

export type ScopePatternOverlap = {
  readonly patternA: string;
  readonly patternB: string;
};

export type TaskResourceConflict = {
  readonly kind: "resource";
  readonly taskIdA: TaskId;
  readonly taskIdB: TaskId;
  readonly resources: readonly string[];
};

export type TaskPathConflict = {
  readonly kind: "path";
  readonly taskIdA: TaskId;
  readonly taskIdB: TaskId;
  readonly patterns: readonly ScopePatternOverlap[];
};

export type TaskConflict = TaskResourceConflict | TaskPathConflict;

/**
 * Detects every logical-resource and filesystem-scope conflict between the
 * given candidate tasks, one conflict per candidate pair per conflict kind.
 */
export function detectTaskConflicts(
  tasks: readonly Task[],
): readonly TaskConflict[] {
  const ordered = [...tasks].sort(compareTasksById);
  const conflicts: TaskConflict[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const first = ordered[i];
      const second = ordered[j];
      if (first === undefined || second === undefined) {
        continue;
      }
      const sharedResources = sharedValues(
        first.definition.resources,
        second.definition.resources,
      );
      if (sharedResources.length > 0) {
        conflicts.push({
          kind: "resource",
          taskIdA: first.id,
          taskIdB: second.id,
          resources: sharedResources,
        });
      }
      const pathOverlaps = scopeOverlaps(
        first.definition.scope,
        second.definition.scope,
      );
      if (pathOverlaps.length > 0) {
        conflicts.push({
          kind: "path",
          taskIdA: first.id,
          taskIdB: second.id,
          patterns: pathOverlaps,
        });
      }
    }
  }
  return conflicts;
}

function compareTasksById(a: Task, b: Task): number {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

/**
 * Values present in both lists (compared with surrounding whitespace
 * trimmed), ascending and without duplicates.
 */
function sharedValues(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const other = new Set(second.map(trimmed));
  const shared = new Set<string>();
  for (const value of first) {
    const normalized = value.trim();
    if (other.has(normalized)) {
      shared.add(normalized);
    }
  }
  return [...shared].sort(compareStrings);
}

function scopeOverlaps(
  scopeA: TaskScope,
  scopeB: TaskScope,
): readonly ScopePatternOverlap[] {
  const overlaps: ScopePatternOverlap[] = [];
  const seen = new Set<string>();
  for (const patternA of scopeA.allowedPaths) {
    const segmentsA = compileScopeSegments(patternA);
    if (segmentsA === undefined) {
      continue;
    }
    for (const patternB of scopeB.allowedPaths) {
      const segmentsB = compileScopeSegments(patternB);
      if (segmentsB === undefined) {
        continue;
      }
      if (!segmentsOverlap(segmentsA, segmentsB)) {
        continue;
      }
      const key = `${patternA}\u0000${patternB}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      overlaps.push({ patternA, patternB });
    }
  }
  overlaps.sort((left, right) => {
    const firstDelta = compareStrings(left.patternA, right.patternA);
    return firstDelta !== 0
      ? firstDelta
      : compareStrings(left.patternB, right.patternB);
  });
  return overlaps;
}

type ScopeSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "wildcard" }
  | { readonly kind: "multi" };

/**
 * Compiles an allowed-path pattern into the bounded segment language of the
 * task scope contracts, mirroring the scope-matching semantics: host path
 * separators are normalized to "/", leading "./" and "/" anchors are
 * removed, a pattern without any "/" is anchored at every depth, a trailing
 * "/" marks a directory scope, and empty or unusable patterns match
 * nothing.
 */
function compileScopeSegments(
  rawPattern: string,
): readonly ScopeSegment[] | undefined {
  let pattern = rawPattern.replaceAll("\\", "/").trim();
  while (pattern.startsWith("./")) {
    pattern = pattern.slice(2);
  }
  while (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const directoryAnchored = pattern.endsWith("/");
  while (pattern.endsWith("/")) {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0) {
    return undefined;
  }
  const segments: ScopeSegment[] = [];
  if (!pattern.includes("/")) {
    segments.push({ kind: "multi" });
  }
  for (const raw of pattern.split("/")) {
    if (raw.length === 0) {
      return undefined;
    }
    if (raw === "**") {
      segments.push({ kind: "multi" });
      continue;
    }
    segments.push(
      raw.includes("*") || raw.includes("?")
        ? { kind: "wildcard" }
        : { kind: "literal", value: raw },
    );
  }
  if (directoryAnchored) {
    segments.push({ kind: "multi" });
  }
  return segments;
}

/**
 * Whether some repository-relative path can match both segment sequences.
 * Literal segments must agree exactly; wildcard segments are matched
 * conservatively against anything; `**` spans any number of segments
 * (including none). Only exact literal mismatches prove disjointness.
 */
function segmentsOverlap(
  segmentsA: readonly ScopeSegment[],
  segmentsB: readonly ScopeSegment[],
): boolean {
  const memo = new Map<string, boolean>();

  const match = (i: number, j: number): boolean => {
    const key = `${String(i)}:${String(j)}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = matchUncached(i, j);
    memo.set(key, result);
    return result;
  };

  const matchUncached = (i: number, j: number): boolean => {
    const segmentA = segmentsA[i];
    const segmentB = segmentsB[j];
    if (segmentA === undefined && segmentB === undefined) {
      return true;
    }
    if (segmentA?.kind === "multi") {
      return match(i + 1, j) || (segmentB !== undefined && match(i, j + 1));
    }
    if (segmentB?.kind === "multi") {
      return match(i, j + 1) || (segmentA !== undefined && match(i + 1, j));
    }
    if (segmentA === undefined || segmentB === undefined) {
      return false;
    }
    return canShareSegment(segmentA, segmentB) && match(i + 1, j + 1);
  };

  return match(0, 0);
}

function canShareSegment(
  segmentA: ScopeSegment,
  segmentB: ScopeSegment,
): boolean {
  if (segmentA.kind === "literal" && segmentB.kind === "literal") {
    return segmentA.value === segmentB.value;
  }
  return true;
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

function trimmed(value: string): string {
  return value.trim();
}
