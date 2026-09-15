import { describe, expect, it } from "vitest";
import {
  buildTaskFromManualInput,
  validateManualTaskInput,
  type ManualTaskValidationResult,
} from "@agentic-dev-runner/core";

function validTaskInput(): Record<string, unknown> {
  return {
    id: "M070",
    title: "Add manual task ingestion",
    milestone: "cli-product-experience",
    status: "READY",
    priority: "P1",
    risk: "low",
    type: "implementation",
    objective: "Allow developers to add manually defined tasks to the runner.",
    acceptanceCriteria: [
      "A valid JSON task file is parsed, validated, and persisted.",
    ],
    dependsOn: ["M067"],
    provenance: { kind: "user_request", source: "manual" },
    scope: {
      allowedPaths: ["packages/cli/**", "packages/core/**"],
      forbiddenPaths: ["docs/**"],
    },
    resources: ["task-ingestion"],
    workflow: "default",
    routing: { complexity: "small", capabilities: ["typescript"] },
    verification: { required: ["typecheck", "unit"] },
    limits: { maxAttempts: 3, maxReviewCycles: 2 },
    approval: { required: false },
  };
}

function validate(input: unknown) {
  const result = validateManualTaskInput(input);
  if (!result.ok) {
    throw new Error(`unexpected validation issues: ${result.issues.join("; ")}`);
  }
  return result.value;
}

function expectIssues(result: ManualTaskValidationResult): readonly string[] {
  if (result.ok) {
    throw new Error("expected validation to fail");
  }
  expect(result.issues.length).toBeGreaterThan(0);
  return result.issues;
}

describe("validateManualTaskInput", () => {
  it("accepts a valid manual task input", () => {
    const value = validate(validTaskInput());
    expect(value.id).toBe("M070");
    expect(value.status).toBe("READY");
    expect(value.dependsOn).toEqual(["M067"]);
  });

  it("rejects non-object input", () => {
    for (const input of [null, undefined, "task", 7, []]) {
      const issues = expectIssues(validateManualTaskInput(input));
      expect(issues.join(" ")).toContain("must be a JSON object");
    }
  });

  it("rejects unknown fields to catch malformed task files", () => {
    const issues = expectIssues(
      validateManualTaskInput({ ...validTaskInput(), agent: "codex" }),
    );
    expect(issues.join(" ")).toContain('unknown field "agent"');
  });

  it("reports each missing required field", () => {
    const requiredFields = [
      "id",
      "title",
      "milestone",
      "status",
      "priority",
      "risk",
      "type",
      "objective",
      "acceptanceCriteria",
      "dependsOn",
      "provenance",
      "scope",
      "resources",
      "workflow",
      "routing",
      "verification",
      "limits",
      "approval",
    ] as const;
    for (const field of requiredFields) {
      const partial = { ...validTaskInput() };
      delete partial[field];
      const issues = expectIssues(validateManualTaskInput(partial));
      expect(
        issues.some((entry) => entry.includes(`.${field}:`)),
        `expected an issue for missing field "${field}", got: ${issues.join("; ")}`,
      ).toBe(true);
    }
  });

  it("rejects empty strings and empty acceptance criteria", () => {
    const emptyTitle = expectIssues(
      validateManualTaskInput({ ...validTaskInput(), title: "   " }),
    );
    expect(emptyTitle.join(" ")).toContain("task definition.title:");

    const emptyCriteria = expectIssues(
      validateManualTaskInput({ ...validTaskInput(), acceptanceCriteria: [] }),
    );
    expect(emptyCriteria.join(" ")).toContain(
      "must contain at least one criterion",
    );

    const blankCriterion = expectIssues(
      validateManualTaskInput({
        ...validTaskInput(),
        acceptanceCriteria: ["Valid.", "   "],
      }),
    );
    expect(blankCriterion.join(" ")).toContain("acceptanceCriteria[1]");
  });

  it("rejects invalid documented enum values", () => {
    const invalidType = expectIssues(
      validateManualTaskInput({ ...validTaskInput(), type: "design" }),
    );
    expect(invalidType.join(" ")).toContain("task definition.type:");

    const invalidRisk = expectIssues(
      validateManualTaskInput({ ...validTaskInput(), risk: "extreme" }),
    );
    expect(invalidRisk.join(" ")).toContain("task definition.risk:");

    const invalidProvenance = expectIssues(
      validateManualTaskInput({
        ...validTaskInput(),
        provenance: { kind: "invented", source: "manual" },
      }),
    );
    expect(invalidProvenance.join(" ")).toContain(
      "task definition.provenance.kind:",
    );

    const invalidComplexity = expectIssues(
      validateManualTaskInput({
        ...validTaskInput(),
        routing: { complexity: "huge", capabilities: ["typescript"] },
      }),
    );
    expect(invalidComplexity.join(" ")).toContain(
      "task definition.routing.complexity:",
    );
  });

  it("rejects initial statuses that are not appropriate for a manually added task", () => {
    for (const status of ["IMPLEMENTING", "DONE", "FAILED", "ready", "PLANNING"]) {
      const issues = expectIssues(
        validateManualTaskInput({ ...validTaskInput(), status }),
      );
      expect(issues.join(" ")).toContain("task definition.status:");
      expect(issues.join(" ")).toContain("BACKLOG or READY");
    }
  });

  it("accepts BACKLOG as an initial status", () => {
    const value = validate({ ...validTaskInput(), status: "BACKLOG" });
    expect(value.status).toBe("BACKLOG");
  });

  it("rejects invalid task IDs", () => {
    for (const invalid of ["", "  ", "M 001", "M001!", "../escape", "a/b"]) {
      const issues = expectIssues(
        validateManualTaskInput({ ...validTaskInput(), id: invalid }),
      );
      expect(issues.join(" ")).toContain("task definition.id:");
    }
  });

  it("validates dependency ID syntax, duplicates, and self references", () => {
    const badSyntax = expectIssues(
      validateManualTaskInput({
        ...validTaskInput(),
        dependsOn: ["M067", "not a task id!"],
      }),
    );
    expect(badSyntax.join(" ")).toContain("dependsOn[1]");

    const duplicate = expectIssues(
      validateManualTaskInput({
        ...validTaskInput(),
        dependsOn: ["M067", "M067"],
      }),
    );
    expect(duplicate.join(" ")).toContain('duplicate dependency "M067"');

    const selfReference = expectIssues(
      validateManualTaskInput({ ...validTaskInput(), dependsOn: ["M070"] }),
    );
    expect(selfReference.join(" ")).toContain(
      'must not reference the task itself ("M070")',
    );
  });

  it("requires limits to be positive integers", () => {
    for (const limits of [
      { maxAttempts: 0, maxReviewCycles: 2 },
      { maxAttempts: 3, maxReviewCycles: -1 },
      { maxAttempts: 1.5, maxReviewCycles: 2 },
      { maxAttempts: "3", maxReviewCycles: 2 },
    ]) {
      const issues = expectIssues(
        validateManualTaskInput({ ...validTaskInput(), limits }),
      );
      expect(issues.join(" ")).toContain("task definition.limits.");
    }
  });

  it("validates scope path patterns", () => {
    for (const scope of [
      { allowedPaths: ["/etc/**"], forbiddenPaths: [] },
      { allowedPaths: [], forbiddenPaths: ["C:\\system/**"] },
      { allowedPaths: ["src\\feature/**"], forbiddenPaths: [] },
      { allowedPaths: [""], forbiddenPaths: [] },
      { allowedPaths: "src/**", forbiddenPaths: [] },
    ]) {
      const issues = expectIssues(
        validateManualTaskInput({ ...validTaskInput(), scope }),
      );
      expect(issues.join(" ")).toContain("task definition.scope.");
    }
  });

  it("requires approval.required to be boolean", () => {
    const issues = expectIssues(
      validateManualTaskInput({
        ...validTaskInput(),
        approval: { required: "no" },
      }),
    );
    expect(issues.join(" ")).toContain("task definition.approval.required:");
  });

  it("collects multiple issues in one pass", () => {
    const issues = expectIssues(
      validateManualTaskInput({
        id: "",
        priority: "urgent",
        risk: "extreme",
      }),
    );
    expect(issues.length).toBeGreaterThan(2);
  });
});

describe("buildTaskFromManualInput", () => {
  it("builds the canonical Task with definition grouping and timestamps", () => {
    const input = validate(validTaskInput());
    const task = buildTaskFromManualInput(input, {
      projectId: "proj-local",
      now: "2026-09-15T00:00:00.000Z",
    });

    expect(task.id).toBe("M070");
    expect(task.projectId).toBe("proj-local");
    expect(task.title).toBe("Add manual task ingestion");
    expect(task.status).toBe("READY");
    expect(task.type).toBe("implementation");
    expect(task.priority).toBe("P1");
    expect(task.risk).toBe("low");
    expect(task.workflow).toBe("default");
    expect(task.dependsOn).toEqual(["M067"]);
    expect(task.provenance).toEqual({ kind: "user_request", source: "manual" });
    expect(task.routing).toEqual({
      complexity: "small",
      capabilities: ["typescript"],
    });
    expect(task.definition.objective).toBe(
      "Allow developers to add manually defined tasks to the runner.",
    );
    expect(task.definition.scope.allowedPaths).toEqual([
      "packages/cli/**",
      "packages/core/**",
    ]);
    expect(task.definition.limits).toEqual({
      maxAttempts: 3,
      maxReviewCycles: 2,
    });
    expect(task.createdAt).toBe("2026-09-15T00:00:00.000Z");
    expect(task.updatedAt).toBe("2026-09-15T00:00:00.000Z");
  });

  it("keeps an approval reason when approval is required", () => {
    const input = validate({
      ...validTaskInput(),
      approval: { required: true, reason: "touches production data" },
    });
    const task = buildTaskFromManualInput(input, {
      projectId: "proj-local",
      now: "2026-09-15T00:00:00.000Z",
    });
    expect(task.definition.approval).toEqual({
      required: true,
      reason: "touches production data",
    });
  });
});
