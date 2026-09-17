import { describe, expect, it } from "vitest";
import { detectTaskConflicts } from "../src/index.js";
import type { Task, TaskConflict } from "../src/index.js";

export function candidateTask(
  id: string,
  overrides?: {
    resources?: string[];
    scope?: { allowedPaths: string[]; forbiddenPaths?: string[] };
  },
): Task {
  return {
    id,
    projectId: "proj-1",
    title: `Task ${id}`,
    milestone: "milestone-1",
    status: "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective: `Objective of ${id}.`,
      acceptanceCriteria: ["Done."],
      scope:
        overrides?.scope === undefined
          ? { allowedPaths: [], forbiddenPaths: [] }
          : {
              allowedPaths: overrides.scope.allowedPaths,
              forbiddenPaths: overrides.scope.forbiddenPaths ?? [],
            },
      resources: overrides?.resources ?? [],
      verification: { required: ["typecheck"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: false },
    },
    routing: { complexity: "small", capabilities: ["typescript"] },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function conflictSignatures(conflicts: readonly TaskConflict[]): string[] {
  return conflicts.map((conflict) =>
    conflict.kind === "resource"
      ? `resource:${conflict.taskIdA}<->${conflict.taskIdB}:[${conflict.resources.join(",")}]`
      : `path:${conflict.taskIdA}<->${conflict.taskIdB}:[${conflict.patterns.map((overlap) => `${overlap.patternA}|${overlap.patternB}`).join(";")}]`,
  );
}

describe("task conflict detection (M046a)", () => {
  it("reports no conflicts for disjoint resources and disjoint scopes", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", {
        resources: ["auth-state"],
        scope: { allowedPaths: ["src/auth/**"] },
      }),
      candidateTask("M002", {
        resources: ["payments"],
        scope: { allowedPaths: ["src/payments/**"] },
      }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("reports no conflicts for tasks with no resources and no writable scope", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001"),
      candidateTask("M002"),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("conflicts when two tasks require the same exclusive resource", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M002", { resources: ["database-schema"] }),
      candidateTask("M001", { resources: ["database-schema"] }),
    ]);
    expect(conflicts).toEqual([
      {
        kind: "resource",
        taskIdA: "M001",
        taskIdB: "M002",
        resources: ["database-schema"],
      },
    ]);
  });

  it("conflicts when only one of several declared resources overlaps", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", {
        resources: ["auth-state", "database-schema", "routing"],
      }),
      candidateTask("M002", { resources: ["payments", "database-schema"] }),
    ]);
    expect(conflicts).toEqual([
      {
        kind: "resource",
        taskIdA: "M001",
        taskIdB: "M002",
        resources: ["database-schema"],
      },
    ]);
  });

  it("conflicts on identical writable paths", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src/auth/**"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/auth/**"] } }),
    ]);
    expect(conflicts).toEqual([
      {
        kind: "path",
        taskIdA: "M001",
        taskIdB: "M002",
        patterns: [{ patternA: "src/auth/**", patternB: "src/auth/**" }],
      },
    ]);
  });

  it("conflicts when one writable scope contains the other", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src/**"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/auth/**"] } }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "path:M001<->M002:[src/**|src/auth/**]",
    ]);
  });

  it("does not conflict on clearly disjoint writable scopes", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", {
        scope: { allowedPaths: ["src/auth/**", "src/auth/*"] },
      }),
      candidateTask("M002", {
        scope: { allowedPaths: ["src/payments/**", "docs/**", "test/**"] },
      }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("conflicts on wildcard scopes that cannot be proven disjoint", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src/v?/**"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/v1/**"] } }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "path:M001<->M002:[src/v?/**|src/v1/**]",
    ]);
  });

  it("conflicts a bare filename pattern against a directory scope conservatively", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["README.md"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/**"] } }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "path:M001<->M002:[README.md|src/**]",
    ]);
  });

  it("treats directory-anchored and glob forms of the same scope as overlapping", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src/"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/**"] } }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "path:M001<->M002:[src/|src/**]",
    ]);
  });

  it("conflicts equivalent-but-incomparable literal prefixes only through shared prefixes", () => {
    const safe = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src/utils/**"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["srcx/**"] } }),
    ]);
    expect(safe).toEqual([]);
    const overlapping = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src/utils/**"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/ut**"] } }),
    ]);
    expect(conflictSignatures(overlapping)).toEqual([
      "path:M001<->M002:[src/utils/**|src/ut**]",
    ]);
  });

  it("never grants ownership through forbidden paths", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", {
        scope: {
          allowedPaths: ["src/auth/**"],
          forbiddenPaths: ["src/shared/**"],
        },
      }),
      candidateTask("M002", {
        scope: {
          allowedPaths: ["src/payments/**"],
          forbiddenPaths: ["src/shared/**"],
        },
      }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("reports resource and path conflicts independently for the same pair", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", {
        resources: ["auth-state"],
        scope: { allowedPaths: ["src/auth/**"] },
      }),
      candidateTask("M002", {
        resources: ["auth-state"],
        scope: { allowedPaths: ["src/auth/**"] },
      }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "resource:M001<->M002:[auth-state]",
      "path:M001<->M002:[src/auth/**|src/auth/**]",
    ]);
  });

  it("evaluates every pair in a multi-task candidate set deterministically", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M003", {
        resources: ["database-schema"],
        scope: { allowedPaths: ["db/**"] },
      }),
      candidateTask("M001", {
        resources: ["auth-state"],
        scope: { allowedPaths: ["src/auth/**"] },
      }),
      candidateTask("M002", {
        resources: ["payments", "database-schema"],
        scope: { allowedPaths: ["db/**", "src/payments/**"] },
      }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "resource:M002<->M003:[database-schema]",
      "path:M002<->M003:[db/**|db/**]",
    ]);
  });

  it("reports multiple overlapping resources and patterns sorted within a conflict", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", {
        resources: ["routing", "auth-state", "payments"],
        scope: { allowedPaths: ["src/z/**", "src/a/**", "src/m/**"] },
      }),
      candidateTask("M002", {
        resources: ["payments", "routing"],
        scope: { allowedPaths: ["src/m/**", "src/a/**"] },
      }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "resource:M001<->M002:[payments,routing]",
      "path:M001<->M002:[src/a/**|src/a/**;src/m/**|src/m/**]",
    ]);
  });

  it("produces identical diagnostics regardless of candidate input ordering", () => {
    const tasks = [
      candidateTask("M001", {
        resources: ["auth-state"],
        scope: { allowedPaths: ["src/auth/**"] },
      }),
      candidateTask("M002", {
        resources: ["payments", "auth-state"],
        scope: { allowedPaths: ["src/payments/**", "src/**"] },
      }),
      candidateTask("M003", {
        resources: ["routing"],
        scope: { allowedPaths: ["docs/**"] },
      }),
    ];
    const forward = detectTaskConflicts(tasks);
    const reversed = detectTaskConflicts([...tasks].reverse());
    const shuffled = detectTaskConflicts([
      tasks[2] as Task,
      tasks[0] as Task,
      tasks[1] as Task,
    ]);
    expect(conflictSignatures(reversed)).toEqual(conflictSignatures(forward));
    expect(conflictSignatures(shuffled)).toEqual(conflictSignatures(forward));
    expect(conflictSignatures(forward)).toEqual([
      "resource:M001<->M002:[auth-state]",
      "path:M001<->M002:[src/auth/**|src/**]",
    ]);
  });

  it("matches resource names trimmed and reports one conflict per shared name", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { resources: ["database-schema"] }),
      candidateTask("M002", { resources: [" database-schema", "database-schema"] }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "resource:M001<->M002:[database-schema]",
    ]);
  });

  it("normalizes host path separators and anchors before comparing scopes", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["src\\auth\\**"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["./src/auth/**"] } }),
    ]);
    expect(conflictSignatures(conflicts)).toEqual([
      "path:M001<->M002:[src\\auth\\**|./src/auth/**]",
    ]);
  });

  it("ignores empty and unusable scope patterns", () => {
    const conflicts = detectTaskConflicts([
      candidateTask("M001", { scope: { allowedPaths: ["", "   ", "/"] } }),
      candidateTask("M002", { scope: { allowedPaths: ["src/**"] } }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("never mutates the candidate tasks", () => {
    const tasks = [
      candidateTask("M002", {
        resources: ["payments"],
        scope: { allowedPaths: ["src/payments/**"] },
      }),
      candidateTask("M001", {
        resources: ["payments"],
        scope: { allowedPaths: ["src/payments/**"] },
      }),
    ];
    const snapshot = JSON.stringify(tasks);
    detectTaskConflicts(tasks);
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});
