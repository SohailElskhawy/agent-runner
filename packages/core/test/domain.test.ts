import { describe, expect, it } from "vitest";
import {
  ATTEMPT_STATUSES,
  CORE_PACKAGE_NAME,
  STAGE_KINDS,
  STAGE_RUN_STATUSES,
  TASK_STATUSES,
  VERIFICATION_KINDS,
  isTaskStatus,
  type Attempt,
  type AttemptFailure,
  type AttemptStatus,
  type Project,
  type StageRun,
  type StageRunFailure,
  type Task,
  type VerificationResult,
} from "@agentic-dev-runner/core";

const project: Project = {
  id: "proj-1",
  name: "fixture",
  rootPath: "/tmp/fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const task: Task = {
  id: "M001",
  projectId: "proj-1",
  title: "Add a small utility function",
  milestone: "milestone-1",
  status: "BACKLOG",
  type: "implementation",
  priority: "P0",
  risk: "low",
  definition: {
    objective: "Add one validated utility function.",
    acceptanceCriteria: ["Valid input returns expected output."],
    scope: {
      allowedPaths: ["src/utils/**"],
      forbiddenPaths: ["docs/**"],
    },
    resources: ["utils"],
    verification: { required: ["typecheck", "unit"] },
    limits: { maxAttempts: 3, maxReviewCycles: 2 },
    approval: { required: false },
  },
  routing: {
    complexity: "small",
    capabilities: ["typescript"],
  },
  provenance: { kind: "user_request", source: "manual" },
  dependsOn: [],
  workflow: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const attempt: Attempt = {
  id: "att-1",
  taskId: "M001",
  number: 1,
  status: "RUNNING",
  agent: "opencode",
  baseRevision: "abc123",
  startedAt: "2026-01-01T00:00:00.000Z",
};

const stageRun: StageRun = {
  id: "stage-1",
  attemptId: "att-1",
  stage: "IMPLEMENT",
  status: "SUCCEEDED",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
};

const verification: VerificationResult = {
  id: "ver-1",
  attemptId: "att-1",
  kind: "typecheck",
  command: ["pnpm", "typecheck"],
  outcome: "PASSED",
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:30.000Z",
};

describe("workspace smoke test", () => {
  it("imports the core workspace package", () => {
    expect(CORE_PACKAGE_NAME).toBe("@agentic-dev-runner/core");
  });
});

describe("task status", () => {
  it("declares the required status set", () => {
    expect([...TASK_STATUSES]).toEqual([
      "BACKLOG",
      "READY",
      "PLANNING",
      "PLAN_REVIEW",
      "IMPLEMENTING",
      "CODE_REVIEW",
      "VERIFYING",
      "INTEGRATING",
      "DONE",
      "BLOCKED",
      "NEEDS_HUMAN",
      "FAILED",
      "CANCELLED",
    ]);
  });

  it("accepts declared statuses and rejects unknown values", () => {
    expect(isTaskStatus("IMPLEMENTING")).toBe(true);
    expect(isTaskStatus("DONE")).toBe(true);
    expect(isTaskStatus("IMPLEMENTATION")).toBe(false);
    expect(isTaskStatus("done")).toBe(false);
    expect(isTaskStatus("")).toBe(false);
    expect(isTaskStatus(42)).toBe(false);
    expect(isTaskStatus(null)).toBe(false);
    expect(isTaskStatus(undefined)).toBe(false);
  });
});

describe("runtime status sets", () => {
  it("declares stage, verification, and attempt status sets", () => {
    expect([...STAGE_KINDS]).toEqual([
      "PLAN",
      "PLAN_REVIEW",
      "IMPLEMENT",
      "CODE_REVIEW",
      "VERIFY",
      "INTEGRATE",
    ]);
    expect([...STAGE_RUN_STATUSES]).toContain("TIMED_OUT");
    expect([...ATTEMPT_STATUSES]).toContain("FAILED");
    expect([...VERIFICATION_KINDS]).toContain("custom");
  });
});

describe("domain entities are serializable", () => {
  it("round-trips a project through JSON", () => {
    const restored: Project = JSON.parse(JSON.stringify(project)) as Project;
    expect(restored).toEqual(project);
  });

  it("round-trips a task through JSON", () => {
    const restored: Task = JSON.parse(JSON.stringify(task)) as Task;
    expect(restored).toEqual(task);
    expect(restored.definition.limits.maxAttempts).toBe(3);
    expect(restored.routing.complexity).toBe("small");
  });

  it("round-trips an attempt with optional execution data", () => {
    const failure: AttemptFailure = {
      kind: "timeout",
      message: "agent exceeded time budget",
    };
    const failed: Attempt = {
      ...attempt,
      status: "TIMED_OUT" satisfies AttemptStatus,
      finishedAt: "2026-01-01T01:00:00.000Z",
      failure,
      contextManifest: {
        entries: [
          { kind: "agents_md", source: "AGENTS.md", digest: "sha256:aa" },
          { kind: "doc", source: "docs/ARCHITECTURE.md", digest: "sha256:bb" },
        ],
        createdAt: "2026-01-01T00:00:05.000Z",
      },
      logs: {
        stdout: "implementation complete",
        stderr: "",
        location: "attempts/att-1/logs",
      },
      tokenUsage: { inputTokens: 1200, outputTokens: 3400 },
      cost: 0.42,
    };
    const restored: Attempt = JSON.parse(JSON.stringify(failed)) as Attempt;
    expect(restored).toEqual(failed);
    expect(restored.failure?.kind).toBe("timeout");
    expect(restored.contextManifest?.entries).toHaveLength(2);
    expect(restored.tokenUsage?.outputTokens).toBe(3400);
  });

  it("round-trips stage runs and verification results", () => {
    const stageFailure: StageRunFailure = {
      kind: "review_rejected",
      message: "plan review rejected the proposal",
    };
    const rejectedStage: StageRun = {
      ...stageRun,
      stage: "PLAN_REVIEW",
      status: "FAILED",
      failure: stageFailure,
    };
    const failedVerification: VerificationResult = {
      ...verification,
      kind: "unit",
      outcome: "FAILED",
      exitCode: 1,
      failure: { message: "3 tests failed", output: "truncated output" },
    };
    const restoredStage: StageRun = JSON.parse(
      JSON.stringify(rejectedStage),
    ) as StageRun;
    const restoredVerification: VerificationResult = JSON.parse(
      JSON.stringify(failedVerification),
    ) as VerificationResult;
    expect(restoredStage).toEqual(rejectedStage);
    expect(restoredVerification).toEqual(failedVerification);
  });
});
