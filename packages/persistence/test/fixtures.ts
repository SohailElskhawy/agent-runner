import type {
  Attempt,
  Project,
  StageRun,
  Task,
} from "@agentic-dev-runner/core";

export function createProject(overrides?: {
  id?: string;
  name?: string;
}): Project {
  return {
    id: overrides?.id ?? "proj-1",
    name: overrides?.name ?? "fixture-project",
    rootPath: "fixtures/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function createTask(overrides?: {
  id?: string;
  projectId?: string;
  status?: Task["status"];
}): Task {
  return {
    id: overrides?.id ?? "M001",
    projectId: overrides?.projectId ?? "proj-1",
    title: "Add a small utility function",
    milestone: "milestone-1",
    status: overrides?.status ?? "BACKLOG",
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
}

export function createAttempt(overrides?: {
  id?: string;
  taskId?: string;
}): Attempt {
  return {
    id: overrides?.id ?? "attempt-1",
    taskId: overrides?.taskId ?? "M001",
    number: 1,
    status: "SUCCEEDED",
    agent: "opencode",
    model: "test-model",
    baseRevision: "abcdef1234567890",
    contextManifest: {
      entries: [{ kind: "file", source: "AGENTS.md", digest: "abc123" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    logs: {
      stdout: "stdout text",
      stderr: "stderr text",
      location: "logs/attempt-1",
    },
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    cost: 0.25,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    failure: { kind: "verification_failed", message: "typecheck failed" },
  };
}

export function createStageRun(overrides?: {
  id?: string;
  attemptId?: string;
  stage?: StageRun["stage"];
  status?: StageRun["status"];
  startedAt?: string;
  finishedAt?: string;
  failure?: StageRun["failure"];
}): StageRun {
  const startedAt = overrides?.startedAt ?? "2026-01-01T00:00:05.000Z";
  const finishedAt = overrides?.finishedAt ?? "2026-01-01T00:00:35.000Z";
  return {
    id: overrides?.id ?? "stage-run-1",
    attemptId: overrides?.attemptId ?? "attempt-1",
    stage: overrides?.stage ?? "IMPLEMENT",
    status: overrides?.status ?? "SUCCEEDED",
    startedAt,
    finishedAt,
    ...(overrides?.failure === undefined
      ? {}
      : { failure: overrides.failure }),
  };
}
