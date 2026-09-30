import { describe, expect, it } from "vitest";
import { normalizeAndValidatePlan } from "@agentic-dev-runner/core";

const milestones = [
  { id: "m1", title: "First", completionCriteria: ["First done"] },
  { id: "m2", title: "Second", completionCriteria: ["Second done"] },
];

function draftTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "T1",
    title: "First task",
    milestone: "m1",
    risk: "low",
    type: "implementation",
    objective: "Build the first part.",
    acceptanceCriteria: ["It works."],
    dependsOn: [],
    provenanceSource: "m1 completion criteria",
    allowedPaths: ["src/**"],
    resources: [],
    routing: { complexity: "small", capabilities: ["typescript"] },
    verification: ["unit"],
    ...overrides,
  };
}

function validate(tasks: readonly Record<string, unknown>[], options: Record<string, unknown> = {}) {
  return normalizeAndValidatePlan(
    { version: 1, kind: "READY_FOR_PLANNING", milestones, tasks },
    { configuredVerificationChecks: ["unit", "typecheck"], ...options },
  );
}

describe("normalizeAndValidatePlan", () => {
  it("fills runner-owned defaults and priorities by milestone order", () => {
    const result = validate([draftTask(), draftTask({ id: "T2", milestone: "m2" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map(({ status, priority, workflow, provenance, scope, approval }) => ({ status, priority, workflow, provenance, scope, approval }))).toEqual([
      { status: "READY", priority: "P0", workflow: "simple", provenance: { kind: "roadmap_criterion", source: "m1 completion criteria" }, scope: { allowedPaths: ["src/**"], forbiddenPaths: [] }, approval: { required: false } },
      { status: "READY", priority: "P1", workflow: "simple", provenance: { kind: "roadmap_criterion", source: "m1 completion criteria" }, scope: { allowedPaths: ["src/**"], forbiddenPaths: [] }, approval: { required: false } },
    ]);
  });

  it("requires approval and security workflow for high risk", () => {
    const result = validate([draftTask({ risk: "high" }), draftTask({ id: "T2", milestone: "m2" })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks[0]?.workflow).toBe("security-critical");
      expect(result.tasks[0]?.approval.required).toBe(true);
    }
  });

  it("uses the default workflow for medium risk", () => {
    const result = validate([draftTask({ risk: "medium" }), draftTask({ id: "T2", milestone: "m2" })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tasks[0]?.workflow).toBe("default");
  });

  it("accumulates duplicate, existing ID, milestone, dependency, and empty milestone issues", () => {
    const result = validate([
      draftTask(),
      draftTask({ id: "T1", milestone: "unknown", dependsOn: ["missing"] }),
    ], { existingTaskIds: ["T1"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/duplicate|already exists|milestone|dependency|no tasks/i);
  });

  it("rejects cycles and unconfigured verification checks", () => {
    const result = validate([
      draftTask({ dependsOn: ["T2"], verification: ["missing"] }),
      draftTask({ id: "T2", dependsOn: ["T1"] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/cycle|missing/i);
  });

  it("rejects absent provenance and tasks over documented size limits", () => {
    const result = validate([draftTask({ provenanceSource: undefined, routing: { complexity: "large", capabilities: [] }, acceptanceCriteria: Array(6).fill("criterion"), allowedPaths: Array.from({ length: 9 }, (_, i) => `src/${i}.ts`) })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/provenance|medium|5|8/i);
  });

  it("reports size and check errors even when task schema validation also fails", () => {
    const result = validate([draftTask({
      provenanceSource: undefined,
      routing: { complexity: "large", capabilities: [] },
      acceptanceCriteria: Array(6).fill("criterion"),
      allowedPaths: Array.from({ length: 9 }, (_, i) => `src/${i}.ts`),
      verification: ["unconfigured"],
    }), draftTask({ id: "T2", milestone: "m2" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/provenance/);
      expect(result.issues.join(" ")).toMatch(/medium/);
      expect(result.issues.join(" ")).toMatch(/5 criteria/);
      expect(result.issues.join(" ")).toMatch(/8 paths/);
      expect(result.issues.join(" ")).toMatch(/unconfigured/);
    }
  });
});
