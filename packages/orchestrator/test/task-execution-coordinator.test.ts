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

  it("admits a zero-resource task at most once across concurrent coordinators", async () => {
    const other = createSqliteRunnerStore({ path: join(directory, "state.db") });
    await other.initialize();
    const started: string[] = [];
    let releaseExecution: (() => void) | undefined;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const createExecutor = (selected: Task): WorkflowTaskExecutor => ({
      async run(): Promise<WorkflowTaskRunOutcome> {
        started.push(selected.id);
        await executionReleased;
        return { kind: "rejected", taskId: selected.id, reason: "fixture" };
      },
    });
    await store.putTask({
      ...task("M010", "P0"),
      definition: { ...task("M010", "P0").definition, resources: [] },
    });
    const first = coordinator(store, 1, createExecutor);
    const second = coordinator(other, 1, createExecutor);
    const firstRun = first.dispatchAvailable();
    const secondRun = second.dispatchAvailable();
    for (let attempt = 0; attempt < 50 && started.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    releaseExecution?.();
    const results = await Promise.all([firstRun, secondRun]);
    await other.close();

    expect(started).toEqual(["M010"]);
    expect(results.flatMap((result) => result.executions)).toHaveLength(1);
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect((await store.listExecutionClaims()).filter((claim) => claim.taskId === "M010")).toHaveLength(1);
  });

  it("durably marks an unexpected active-workflow exception for recovery", async () => {
    await store.putTask(task("M011", "P0", "resource-exception", "src/exception/**"));
    const result = await coordinator(store, 1, () => ({
      async run(): Promise<WorkflowTaskRunOutcome> {
        await store.setTaskStatus("M011", "IMPLEMENTING", "2026-01-01T00:00:00.000Z");
        throw new Error("unexpected executor failure");
      },
    })).dispatchAvailable();

    expect(result.executions[0]?.recoveryRequired).toBe(true);
    expect((await store.getTask("M011"))?.status).toBe("NEEDS_HUMAN");
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);
  });

  it("renews a live execution lease until normal settlement and clears its heartbeat", async () => {
    await store.putTask(task("M012", "P0", "heartbeat-resource", "src/heartbeat/**"));
    let release: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const first = createTaskExecutionCoordinator({
      store,
      agentCandidates: [candidate],
      maxParallelism: 1,
      leaseDurationMs: 30,
      createExecutor: () => ({
        async run(): Promise<WorkflowTaskRunOutcome> {
          await running;
          await store.setTaskStatus("M012", "DONE", new Date().toISOString());
          return { kind: "completed", taskId: "M012", attemptId: "att", task: (await store.getTask("M012"))!, attempt: {} as never, branch: "branch", worktreePath: "worktree", integration: { kind: "fast-forward", revision: "revision" }, cleanup: undefined };
        },
      }),
    });
    const run = first.dispatchAvailable();
    await new Promise((resolve) => setTimeout(resolve, 55));
    const active = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(active).toHaveLength(1);
    expect(Date.parse(active[0]!.leaseExpiresAt)).toBeGreaterThan(Date.now() - 30);
    release?.();
    await run;
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
  });

  it("rejects terminal settlement and retains claim/locks when lease expires before settlement", async () => {
    await store.putTask(task("M013", "P0", "expired-resource", "src/expired/**"));
    let currentTime = "2026-01-01T00:00:00.000Z";
    const coord = createTaskExecutionCoordinator({
      store,
      agentCandidates: [candidate],
      maxParallelism: 1,
      leaseDurationMs: 10_000,
      now: () => currentTime,
      createExecutor: () => ({
        async run(): Promise<WorkflowTaskRunOutcome> {
          currentTime = "2026-01-01T00:00:15.000Z";
          await store.setTaskStatus("M013", "DONE", currentTime);
          return { kind: "completed", taskId: "M013", attemptId: "att", task: (await store.getTask("M013"))!, attempt: {} as never, branch: "branch", worktreePath: "worktree", integration: { kind: "fast-forward", revision: "revision" }, cleanup: undefined };
        },
      }),
    });
    const result = await coord.dispatchAvailable();
    expect(result.executions[0]?.recoveryRequired).toBe(true);
    const active = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(active).toHaveLength(1);
    expect(active[0]?.taskId).toBe("M013");
    expect(await store.listResourceLocks()).toHaveLength(1);
  });

  it("rejects normal settlement when recovery actor acquires ownership during execution", async () => {
    await store.putTask(task("M014", "P0", "collision-resource", "src/collision/**"));
    let currentTime = "2026-01-01T00:00:00.000Z";
    const coord = createTaskExecutionCoordinator({
      store,
      agentCandidates: [candidate],
      maxParallelism: 1,
      leaseDurationMs: 10_000,
      now: () => currentTime,
      createExecutor: (_t, execId) => ({
        async run(): Promise<WorkflowTaskRunOutcome> {
          currentTime = "2026-01-01T00:00:15.000Z";
          const acquired = await store.claimExpiredExecutionRecovery(
            execId,
            "recovery_actor_b",
            currentTime,
            "2026-01-01T00:01:00.000Z",
          );
          expect(acquired).toBe(true);
          await store.setTaskStatus("M014", "DONE", currentTime);
          return { kind: "completed", taskId: "M014", attemptId: "att", task: (await store.getTask("M014"))!, attempt: {} as never, branch: "branch", worktreePath: "worktree", integration: { kind: "fast-forward", revision: "revision" }, cleanup: undefined };
        },
      }),
    });
    const result = await coord.dispatchAvailable();
    expect(result.executions[0]?.recoveryRequired).toBe(true);
    const active = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(active).toHaveLength(1);
    expect(await store.listResourceLocks()).toHaveLength(1);
  });

  it("retains claim/locks and rejects completion when heartbeat renewal fails", async () => {
    await store.putTask(task("M015", "P0", "fail-renewal-resource", "src/fail-renewal/**"));
    let releaseRun: (() => void) | undefined;
    const runBlocker = new Promise<void>((resolve) => { releaseRun = resolve; });
    const coord = createTaskExecutionCoordinator({
      store,
      agentCandidates: [candidate],
      maxParallelism: 1,
      leaseDurationMs: 30,
      createExecutor: (_t, execId) => ({
        async run(): Promise<WorkflowTaskRunOutcome> {
          const acquired = await store.claimExpiredExecutionRecovery(
            execId,
            "competing_recovery",
            new Date(Date.now() + 100_000).toISOString(),
            new Date(Date.now() + 160_000).toISOString(),
          );
          expect(acquired).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 50));
          releaseRun?.();
          await store.setTaskStatus("M015", "DONE", new Date().toISOString());
          return { kind: "completed", taskId: "M015", attemptId: "att", task: (await store.getTask("M015"))!, attempt: {} as never, branch: "branch", worktreePath: "worktree", integration: { kind: "fast-forward", revision: "revision" }, cleanup: undefined };
        },
      }),
    });
    const dispatch = coord.dispatchAvailable();
    await runBlocker;
    const result = await dispatch;
    expect(result.executions[0]?.recoveryRequired).toBe(true);
    const active = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(active).toHaveLength(1);
    expect(await store.listResourceLocks()).toHaveLength(1);
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
