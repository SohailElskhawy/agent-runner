import { describe, expect, it } from "vitest";
import {
  selectRunnableTasks,
  TASK_INELIGIBILITY_REASONS,
  type AgentProfile,
  type AgentRouteCandidate,
  type Task,
} from "@agentic-dev-runner/core";

function makeTask(overrides?: {
  id?: string;
  status?: Task["status"];
  priority?: Task["priority"];
  dependsOn?: readonly string[];
  approvalRequired?: boolean;
  capabilities?: readonly string[];
  maxAttempts?: number;
}): Task {
  return {
    id: overrides?.id ?? "M001",
    projectId: "proj-1",
    title: "Add a small utility function",
    milestone: "milestone-1",
    status: overrides?.status ?? "READY",
    type: "implementation",
    priority: overrides?.priority ?? "P0",
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
      limits: {
        maxAttempts: overrides?.maxAttempts ?? 3,
        maxReviewCycles: 2,
      },
      approval: { required: overrides?.approvalRequired ?? false },
    },
    routing: {
      complexity: "small",
      capabilities: overrides?.capabilities ?? ["typescript"],
    },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: overrides?.dependsOn ?? [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function profile(overrides?: {
  id?: string;
  adapterId?: string;
  capabilities?: readonly string[];
}): AgentProfile {
  return {
    id: overrides?.id ?? "profile-a",
    adapterId: overrides?.adapterId ?? "adapter-a",
    capabilities: overrides?.capabilities ?? ["typescript"],
  };
}

function candidate(
  profileOverride?: Parameters<typeof profile>[0],
  available = true,
): AgentRouteCandidate {
  return {
    profile: profile(profileOverride),
    availability: {
      id: profileOverride?.adapterId ?? "adapter-a",
      available,
    },
  };
}

function selection(overrides?: {
  tasks?: readonly Task[];
  attemptCounts?: ReadonlyMap<string, number>;
  agentCandidates?: readonly AgentRouteCandidate[];
}) {
  return selectRunnableTasks({
    tasks: overrides?.tasks ?? [makeTask()],
    attemptCounts: overrides?.attemptCounts ?? new Map(),
    agentCandidates: overrides?.agentCandidates ?? [candidate()],
  });
}

describe("selectRunnableTasks", () => {
  it("declares the canonical ineligibility reasons", () => {
    expect([...TASK_INELIGIBILITY_REASONS]).toEqual([
      "not-ready",
      "dependency-not-done",
      "approval-required",
      "attempt-limit-exhausted",
      "no-eligible-agent",
    ]);
  });

  it("selects a READY task with satisfied dependencies when an eligible agent exists", () => {
    const task = makeTask();
    const result = selection({ tasks: [task] });

    expect(result.runnable).toEqual([task]);
    expect(result.ineligible).toEqual([]);
  });

  it("does not select a task whose status is not READY", () => {
    const task = makeTask({ status: "BLOCKED" });
    const result = selection({ tasks: [task] });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: { reason: "not-ready", status: "BLOCKED" },
      },
    ]);
  });

  it("does not select a task with one incomplete dependency", () => {
    const dependency = makeTask({ id: "M002", status: "IMPLEMENTING" });
    const task = makeTask({ id: "M001", dependsOn: ["M002"] });
    const result = selection({ tasks: [task, dependency] });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: {
          reason: "dependency-not-done",
          notDoneDependencies: ["M002"],
        },
      },
      {
        taskId: "M002",
        ineligibility: { reason: "not-ready", status: "IMPLEMENTING" },
      },
    ]);
  });

  it("selects a task whose dependencies are all DONE", () => {
    const first = makeTask({ id: "M002", status: "DONE" });
    const second = makeTask({ id: "M003", status: "DONE" });
    const task = makeTask({ id: "M001", dependsOn: ["M002", "M003"] });
    const result = selection({ tasks: [task, first, second] });

    expect(result.runnable).toEqual([task]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M002",
        ineligibility: { reason: "not-ready", status: "DONE" },
      },
      {
        taskId: "M003",
        ineligibility: { reason: "not-ready", status: "DONE" },
      },
    ]);
  });

  it("treats a dependency missing from the evaluated collection as not done", () => {
    const task = makeTask({ id: "M001", dependsOn: ["M999"] });
    const result = selection({ tasks: [task] });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: {
          reason: "dependency-not-done",
          notDoneDependencies: ["M999"],
        },
      },
    ]);
  });

  it("reports dependencies that are not done in depends_on order", () => {
    const task = makeTask({ id: "M001", dependsOn: ["M002", "M003", "M004"] });
    const done = makeTask({ id: "M002", status: "DONE" });
    const planning = makeTask({ id: "M003", status: "PLANNING" });
    const failed = makeTask({ id: "M004", status: "FAILED" });
    const result = selection({ tasks: [task, done, planning, failed] });

    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: {
          reason: "dependency-not-done",
          notDoneDependencies: ["M003", "M004"],
        },
      },
      {
        taskId: "M002",
        ineligibility: { reason: "not-ready", status: "DONE" },
      },
      {
        taskId: "M003",
        ineligibility: { reason: "not-ready", status: "PLANNING" },
      },
      {
        taskId: "M004",
        ineligibility: { reason: "not-ready", status: "FAILED" },
      },
    ]);
  });

  it("selects a task while its attempt budget remains", () => {
    const task = makeTask({ maxAttempts: 3 });
    const result = selection({
      tasks: [task],
      attemptCounts: new Map([["M001", 2]]),
    });

    expect(result.runnable).toEqual([task]);
    expect(result.ineligible).toEqual([]);
  });

  it("does not select a task whose maxAttempts budget is exhausted", () => {
    const task = makeTask({ maxAttempts: 3 });
    const result = selection({
      tasks: [task],
      attemptCounts: new Map([["M001", 3]]),
    });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: {
          reason: "attempt-limit-exhausted",
          attempts: 3,
          maxAttempts: 3,
        },
      },
    ]);
  });

  it("selects a task when an eligible agent candidate exists", () => {
    const task = makeTask({ capabilities: ["typescript", "debugging"] });
    const result = selection({
      tasks: [task],
      agentCandidates: [
        candidate({ capabilities: ["typescript"] }, true),
        candidate({ id: "profile-b", capabilities: ["typescript", "debugging"] }, true),
      ],
    });

    expect(result.runnable).toEqual([task]);
    expect(result.ineligible).toEqual([]);
  });

  it("does not select a task when no eligible agent exists", () => {
    const task = makeTask({ capabilities: ["react-native"] });
    const result = selection({
      tasks: [task],
      agentCandidates: [candidate()],
    });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: {
          reason: "no-eligible-agent",
          rejections: [
            {
              reason: "missing-capabilities",
              profileId: "profile-a",
              missingCapabilities: ["react-native"],
            },
          ],
        },
      },
    ]);
  });

  it("does not select a task whose adapter is unavailable", () => {
    const task = makeTask();
    const result = selection({
      tasks: [task],
      agentCandidates: [candidate(undefined, false)],
    });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible[0]?.ineligibility).toEqual({
      reason: "no-eligible-agent",
      rejections: [{ reason: "adapter-unavailable", profileId: "profile-a" }],
    });
  });

  it("reports a task that requires human approval as ineligible", () => {
    const task = makeTask({ approvalRequired: true });
    const result = selection({ tasks: [task] });

    expect(result.runnable).toEqual([]);
    expect(result.ineligible).toEqual([
      {
        taskId: "M001",
        ineligibility: { reason: "approval-required" },
      },
    ]);
  });

  it("evaluates multiple tasks deterministically in input order", () => {
    const done = makeTask({ id: "M003", status: "DONE" });
    const runnable = makeTask({ id: "M001" });
    const wrongStatus = makeTask({ id: "M004", status: "NEEDS_HUMAN" });
    const dependencyBlocked = makeTask({
      id: "M002",
      dependsOn: ["M004"],
      status: "READY",
    });
    const approved = makeTask({ id: "M005", approvalRequired: true });
    const exhausted = makeTask({ id: "M006", maxAttempts: 1 });
    const noAgent = makeTask({ id: "M007", capabilities: ["cobol"] });

    const result = selection({
      tasks: [
        done,
        runnable,
        dependencyBlocked,
        wrongStatus,
        approved,
        exhausted,
        noAgent,
      ],
      attemptCounts: new Map([["M006", 1]]),
      agentCandidates: [candidate()],
    });

    expect(result.runnable).toEqual([runnable]);
    expect(result.ineligible.map((entry) => entry.taskId)).toEqual([
      "M003",
      "M002",
      "M004",
      "M005",
      "M006",
      "M007",
    ]);
    expect(result.ineligible.map((entry) => entry.ineligibility.reason)).toEqual([
      "not-ready",
      "dependency-not-done",
      "not-ready",
      "approval-required",
      "attempt-limit-exhausted",
      "no-eligible-agent",
    ]);
  });

  it("produces the identical selection for repeated invocations", () => {
    const input = {
      tasks: [
        makeTask({ id: "M001" }),
        makeTask({ id: "M002", status: "FAILED" as const }),
      ],
      attemptCounts: new Map([["M001", 1]]),
      agentCandidates: [candidate()],
    };

    const first = selectRunnableTasks(input);
    const second = selectRunnableTasks(input);

    expect(first).toEqual(second);
  });

  it("never mutates the input collection or the tasks", () => {
    const runnableTask = makeTask({ id: "M001" });
    const failedTask = makeTask({ id: "M002", status: "FAILED" });
    const tasks = [runnableTask, failedTask];
    const attemptCounts = new Map([["M001", 1]]);
    const candidates = [candidate()];
    const tasksSnapshot = structuredClone(tasks);
    const attemptCountsSnapshot = new Map(attemptCounts);

    const result = selectRunnableTasks({
      tasks,
      attemptCounts,
      agentCandidates: candidates,
    });

    expect(tasks).toEqual(tasksSnapshot);
    expect(attemptCounts).toEqual(attemptCountsSnapshot);
    expect(result.runnable[0]).toBe(runnableTask);
    runnableTask.status = "DONE";
    expect(result.runnable[0]?.status).toBe("DONE");
  });
});
