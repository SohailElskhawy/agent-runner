import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW,
  SECURITY_CRITICAL_WORKFLOW,
  SIMPLE_WORKFLOW,
  STAGE_KINDS,
  resolveWorkflow,
  validateWorkflowDefinition,
  type StageKind,
  type WorkflowDefinition,
  type WorkflowValidationResult,
} from "@agentic-dev-runner/core";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { id: "custom", stages: ["IMPLEMENT", "VERIFY", "INTEGRATE"], ...overrides };
}

function validate(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowValidationResult {
  return validateWorkflowDefinition(definition(overrides));
}

describe("resolveWorkflow", () => {
  it("resolves the simple workflow to its exact stage order", () => {
    expect(resolveWorkflow("simple")).toEqual({
      resolved: true,
      workflow: {
        id: "simple",
        stages: ["IMPLEMENT", "VERIFY", "INTEGRATE"],
      },
    });
  });

  it("resolves the default workflow to its exact stage order", () => {
    expect(resolveWorkflow("default")).toEqual({
      resolved: true,
      workflow: {
        id: "default",
        stages: [
          "PLAN",
          "PLAN_REVIEW",
          "IMPLEMENT",
          "CODE_REVIEW",
          "VERIFY",
          "INTEGRATE",
        ],
      },
    });
  });

  it("resolves the security-critical workflow with the default stage order", () => {
    expect(resolveWorkflow("security-critical")).toEqual({
      resolved: true,
      workflow: {
        id: "security-critical",
        stages: [
          "PLAN",
          "PLAN_REVIEW",
          "IMPLEMENT",
          "CODE_REVIEW",
          "VERIFY",
          "INTEGRATE",
        ],
      },
    });
  });

  it("resolves only the known built-in workflow ids", () => {
    for (const id of ["simple", "default", "security-critical"]) {
      const result = resolveWorkflow(id);
      if (!result.resolved) {
        throw new Error(`expected ${id} to resolve`);
      }
      expect(result.workflow.id).toBe(id);
    }
  });

  it("returns a structured unknown-workflow failure for unknown ids", () => {
    expect(resolveWorkflow("rapid-prototype")).toEqual({
      resolved: false,
      reason: "unknown-workflow",
      workflowId: "rapid-prototype",
    });
  });

  it("returns a structured failure for empty and whitespace-only ids", () => {
    expect(resolveWorkflow("")).toEqual({
      resolved: false,
      reason: "unknown-workflow",
      workflowId: "",
    });
    expect(resolveWorkflow("  ")).toEqual({
      resolved: false,
      reason: "unknown-workflow",
      workflowId: "  ",
    });
  });

  it("resolves deterministically: identical ids always yield identical results", () => {
    expect(resolveWorkflow("default")).toEqual(resolveWorkflow("default"));
    expect(resolveWorkflow("simple")).toEqual(resolveWorkflow("simple"));
    expect(resolveWorkflow("security-critical")).toEqual(
      resolveWorkflow("security-critical"),
    );
  });

  it("contains no provider-specific behavior: provider ids are just unknown workflows", () => {
    for (const id of ["opencode", "codex", "claude"]) {
      expect(resolveWorkflow(id)).toEqual({
        resolved: false,
        reason: "unknown-workflow",
        workflowId: id,
      });
    }
  });

  it("returns frozen built-in definitions whose stage order cannot be mutated", () => {
    const result = resolveWorkflow("default");
    if (!result.resolved) {
      throw new Error("expected default to resolve");
    }
    expect(Object.isFrozen(result.workflow)).toBe(true);
    expect(Object.isFrozen(result.workflow.stages)).toBe(true);
  });
});

describe("built-in definitions", () => {
  it("covers exactly the built-in workflow ids", () => {
    expect([SIMPLE_WORKFLOW.id, DEFAULT_WORKFLOW.id, SECURITY_CRITICAL_WORKFLOW.id]).toEqual(
      ["simple", "default", "security-critical"],
    );
  });

  it("uses only the defined V0.1 lifecycle stage identifiers", () => {
    for (const workflow of [
      SIMPLE_WORKFLOW,
      DEFAULT_WORKFLOW,
      SECURITY_CRITICAL_WORKFLOW,
    ]) {
      for (const stage of workflow.stages) {
        expect(STAGE_KINDS).toContain(stage);
      }
    }
  });

  it("never duplicates a stage within a built-in workflow", () => {
    for (const workflow of [
      SIMPLE_WORKFLOW,
      DEFAULT_WORKFLOW,
      SECURITY_CRITICAL_WORKFLOW,
    ]) {
      expect(new Set(workflow.stages).size).toBe(workflow.stages.length);
    }
  });

  it("keeps the execution backbone in executable order", () => {
    for (const workflow of [
      SIMPLE_WORKFLOW,
      DEFAULT_WORKFLOW,
      SECURITY_CRITICAL_WORKFLOW,
    ]) {
      const implement = workflow.stages.indexOf("IMPLEMENT");
      const verify = workflow.stages.indexOf("VERIFY");
      const integrate = workflow.stages.indexOf("INTEGRATE");
      expect(implement).toBeLessThan(verify);
      expect(verify).toBeLessThan(integrate);
    }
  });
});

describe("validateWorkflowDefinition", () => {
  it("accepts a valid definition unchanged", () => {
    expect(validate()).toEqual({
      valid: true,
      definition: definition(),
    });
  });

  it("rejects an empty workflow id", () => {
    expect(validate({ id: "" })).toEqual({
      valid: false,
      issues: [{ reason: "empty-workflow-id" }],
    });
    expect(validate({ id: "   " })).toEqual({
      valid: false,
      issues: [{ reason: "empty-workflow-id" }],
    });
  });

  it("rejects an empty stage sequence", () => {
    expect(validate({ stages: [] })).toEqual({
      valid: false,
      issues: [
        { reason: "empty-stage-sequence" },
        { reason: "missing-required-stage", stage: "IMPLEMENT" },
        { reason: "missing-required-stage", stage: "VERIFY" },
        { reason: "missing-required-stage", stage: "INTEGRATE" },
      ],
    });
  });

  it("rejects duplicate stages", () => {
    expect(
      validate({ stages: ["IMPLEMENT", "VERIFY", "VERIFY", "INTEGRATE"] }),
    ).toEqual({
      valid: false,
      issues: [
        {
          reason: "duplicate-stage",
          stage: "VERIFY",
          firstIndex: 1,
          duplicateIndex: 2,
        },
      ],
    });
  });

  it("rejects VERIFY before IMPLEMENT", () => {
    expect(
      validate({ stages: ["VERIFY", "IMPLEMENT", "INTEGRATE"] }),
    ).toEqual({
      valid: false,
      issues: [
        {
          reason: "invalid-stage-order",
          before: "IMPLEMENT",
          after: "VERIFY",
        },
      ],
    });
  });

  it("rejects INTEGRATE before VERIFY", () => {
    expect(
      validate({ stages: ["INTEGRATE", "IMPLEMENT", "VERIFY"] }),
    ).toEqual({
      valid: false,
      issues: [
        {
          reason: "invalid-stage-order",
          before: "VERIFY",
          after: "INTEGRATE",
        },
      ],
    });
  });

  it("rejects each missing required execution stage", () => {
    const required: StageKind[] = ["IMPLEMENT", "VERIFY", "INTEGRATE"];
    for (const missing of required) {
      const stages = required.filter((stage) => stage !== missing);
      expect(validate({ stages })).toEqual({
        valid: false,
        issues: [{ reason: "missing-required-stage", stage: missing }],
      });
    }
  });

  it("collects multiple issues for a fully invalid definition", () => {
    expect(validate({ id: "", stages: [] })).toEqual({
      valid: false,
      issues: [
        { reason: "empty-workflow-id" },
        { reason: "empty-stage-sequence" },
        { reason: "missing-required-stage", stage: "IMPLEMENT" },
        { reason: "missing-required-stage", stage: "VERIFY" },
        { reason: "missing-required-stage", stage: "INTEGRATE" },
      ],
    });
  });

  it("validates deterministically for identical input", () => {
    const invalid = { id: "x", stages: ["VERIFY", "IMPLEMENT"] } as const;
    expect(validateWorkflowDefinition(invalid)).toEqual(
      validateWorkflowDefinition(invalid),
    );
  });
});
