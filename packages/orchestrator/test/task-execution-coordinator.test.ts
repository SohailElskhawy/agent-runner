import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentRouteCandidate,
  Task,
} from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import {
  createTaskExecutionCoordinator,
  type WorkflowTaskExecutor,
} from "../src/index.js";
import type { WorkflowTaskRunOutcome } from "../src/workflow-outcome.js";
import { createProject, createTask } from "./fixtures.js";

const candidate: AgentRouteCandidate = {
  profile: {
    id: "profile-a",
    adapterId: "adapter-a",
    capabilities: ["typescript"],
  },
  availability: { id: "adapter-a", available: true },
};

describe("task execution coordinator (M061b)", () => {
  let directory: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m061b-"));
    store = createSqliteRunnerStore({ path: join(directory, "state.db") });
    await store.initialize();
    await store.putProject(createProject());
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("admits candidates in deterministic priority and id order", async () => {
    const calls: string[] = [];
    await store.putTask(task("M002", "P1"));
    await store.putTask(task("M001", "P0"));
    await store.putTask(task("M003", "P0"));

    const result = await coordinator(store, 3, (selected) => {
      calls.push(selected.id);
      return completedExecutor();
    }).dispatchAvailable();

    expect(calls).toEqual(["M001", "M003", "M002"]);
    expect(result.admissions.every((admission) => admission.kind === "admitted")).toBe(true);
  });

  it("enforces capacity and starts independent tasks concurrently", async () => {
    let running = 0;
    let maximum = 0;
    await store.putTask(task("M001", "P0", "resource-a", "src/a/**"));
    await store.putTask(task("M002", "P0", "resource-b", "src/b/**"));
    await store.putTask(task("M003", "P0", "resource-c", "src/c/**"));

    const result = await coordinator(store, 2, () => ({
      async run(): Promise<WorkflowTaskRunOutcome> {
        running += 1;
        maximum = Math.max(maximum, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { kind: "rejected", taskId: "unused", reason: "test" };
      },
    })).dispatchAvailable();

    expect(maximum).toBe(2);
    expect(result.admissions.filter((item) => item.kind === "admitted")).toHaveLength(2);
    expect(result.admissions.find((item) => item.taskId === "M003"))?.toMatchObject({
      kind: "deferred",
      reason: "capacity-exhausted",
    });
  });

  it("uses conflict preflight and continues after lock contention", async () => {
    await store.putTask(task("M001", "P0", "shared", "src/a/**"));
    await store.putTask(task("M002", "P0", "shared", "src/b/**"));
    await store.putTask(task("M003", "P0", "independent", "src/c/**"));
    await store.putTask(task("M009", "P2", "shared", "src/z/**", "BACKLOG"));
    await store.acquireResourceLocks([{ resource: "shared", taskId: "M009" }]);

    const calls: string[] = [];
    const result = await coordinator(store, 3, (selected) => {
      calls.push(selected.id);
      return completedExecutor();
    }).dispatchAvailable();

    expect(calls).toEqual(["M003"]);
    expect(result.admissions.find((item) => item.taskId === "M002"))?.toMatchObject({
      kind: "deferred",
      reason: "lock-unavailable",
    });
    expect(result.admissions.find((item) => item.taskId === "M003"))?.toMatchObject({
      kind: "admitted",
    });
  });

  it("does not start an active task twice", async () => {
    await store.putTask(task("M001", "P0", "resource-a", "src/a/**", "IMPLEMENTING"));
    const calls: string[] = [];
    const result = await coordinator(store, 2, (selected) => {
      calls.push(selected.id);
      return completedExecutor();
    }).dispatchAvailable();

    expect(calls).toEqual([]);
    expect(result.executions).toEqual([]);
  });
});

function coordinator(
  store: RunnerStore,
  maxParallelism: number,
  createExecutor: (task: Task) => WorkflowTaskExecutor,
) {
  return createTaskExecutionCoordinator({
    store,
    agentCandidates: [candidate],
    maxParallelism,
    createExecutor,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

function completedExecutor(): WorkflowTaskExecutor {
  return {
    async run(): Promise<WorkflowTaskRunOutcome> {
      return { kind: "rejected", taskId: "test", reason: "completed fixture" };
    },
  };
}

function task(
  id: string,
  priority: Task["priority"],
  resource = id,
  allowedPath = `src/${id}/**`,
  status: Task["status"] = "READY",
): Task {
  const value = createTask({ id, status });
  return {
    ...value,
    priority,
    definition: {
      ...value.definition,
      resources: [resource],
      scope: { ...value.definition.scope, allowedPaths: [allowedPath] },
    },
  };
}
