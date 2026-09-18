import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attempt, IntegrationQueueEntry, Task } from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import {
  createTaskExecutionCoordinator,
  createUnattendedScheduler,
  type IntegrationQueueProcessor,
  type IntegrationQueueProcessorOutcome,
  type WorkflowTaskExecutor,
  type WorkflowTaskRunOutcome,
} from "../src/index.js";
import { createProject, createTask } from "./fixtures.js";

describe("unattended scheduler continuation (M066a)", () => {
  let directory: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m066a-"));
    store = createSqliteRunnerStore({ path: join(directory, "state.db") });
    await store.initialize();
    await store.putProject(createProject());
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("continues after one failure, serially settles integration, and unlocks a dependent task", async () => {
    const taskA = task("A", "resource-a", "src/a/**");
    const taskB = task("B", "resource-b", "src/b/**");
    const taskC = {
      ...task("C", "resource-c", "src/c/**"),
      dependsOn: ["B"],
    };
    await store.putTask(taskA);
    await store.putTask(taskB);
    await store.putTask(taskC);

    const executionOrder: string[] = [];
    let running = 0;
    let maximumRunning = 0;
    let pendingExecutionId = "";
    const coordinator = createTaskExecutionCoordinator({
      store,
      agentCandidates: [
        {
          profile: {
            id: "profile-a",
            adapterId: "adapter-a",
            capabilities: ["typescript"],
          },
          availability: { id: "adapter-a", available: true },
        },
      ],
      maxParallelism: 2,
      createExecutor: (selected, executionId) => fakeExecutor(selected, async () => {
        executionOrder.push(selected.id);
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        if (selected.id === "A") {
          await store.setTaskStatus("A", "FAILED", clock());
          return failedOutcome(selected);
        }
        if (selected.id === "B") {
          pendingExecutionId = executionId;
          await store.setTaskStatus("B", "INTEGRATING", clock());
          return pendingOutcome(selected, executionId);
        }
        await store.setTaskStatus("C", "DONE", clock());
        return completedOutcome(selected);
      }),
      now: clock,
    });

    let processedB = false;
    let observedPendingLock = false;
    const integration: IntegrationQueueProcessor = {
      async processNext(): Promise<IntegrationQueueProcessorOutcome> {
        if (processedB) {
          return { kind: "empty" };
        }
        processedB = true;
        observedPendingLock = (await store.listResourceLocks({ taskId: "B" })).length === 1;
        await store.setTaskStatus("B", "DONE", clock());
        await store.releaseTaskExecution(pendingExecutionId, "COMPLETED", clock());
        return {
          kind: "processed",
          entry: queueEntry("B"),
          taskRevision: "revision-B",
          integration: { kind: "fast-forward", revision: "revision-B" },
        };
      },
    };

    const result = await createUnattendedScheduler({ coordinator, integration }).run();

    expect(result.kind).toBe("quiescent");
    expect(executionOrder).toEqual(["A", "B", "C"]);
    expect(maximumRunning).toBe(2);
    expect(observedPendingLock).toBe(true);
    expect((await store.getTask("A"))?.status).toBe("FAILED");
    expect((await store.getTask("B"))?.status).toBe("DONE");
    expect((await store.getTask("C"))?.status).toBe("DONE");
    expect(await store.listResourceLocks()).toEqual([]);
    expect(result.failedTaskIds).toContain("A");
    expect(result.completedTaskIds).toContain("B");
    expect(result.completedTaskIds).toContain("C");
  });
});

function fakeExecutor(
  _task: Task,
  run: () => Promise<WorkflowTaskRunOutcome>,
): WorkflowTaskExecutor {
  return { run };
}

function task(id: string, resource: string, allowedPath: string): Task {
  const value = createTask({ id, status: "READY" });
  return {
    ...value,
    definition: {
      ...value.definition,
      resources: [resource],
      scope: { ...value.definition.scope, allowedPaths: [allowedPath] },
      verification: { required: ["unit"] },
    },
  };
}

function attemptFor(task: Task): Attempt {
  return {
    id: `att_${task.id}`,
    taskId: task.id,
    number: 1,
    status: "RUNNING",
    agent: "fake-agent",
    baseRevision: "base",
    startedAt: clock(),
  };
}

function failedOutcome(task: Task): WorkflowTaskRunOutcome {
  return {
    kind: "failed",
    taskId: task.id,
    task,
    attempt: attemptFor(task),
    reason: "fixture failure",
  };
}

function pendingOutcome(task: Task, executionId: string): WorkflowTaskRunOutcome {
  return {
    kind: "pending-integration",
    taskId: task.id,
    task,
    attempt: attemptFor(task),
    attemptId: `att_${task.id}`,
    branch: `task/${task.id}/attempt-1`,
    worktreePath: `worktrees/${task.id}/attempt-1`,
    taskRevision: `revision-${task.id}`,
    executionId,
  };
}

function completedOutcome(task: Task): WorkflowTaskRunOutcome {
  return {
    kind: "completed",
    taskId: task.id,
    task,
    attempt: { ...attemptFor(task), status: "SUCCEEDED", finishedAt: clock() },
    attemptId: `att_${task.id}`,
    branch: `task/${task.id}/attempt-1`,
    worktreePath: `worktrees/${task.id}/attempt-1`,
    integration: { kind: "fast-forward", revision: `revision-${task.id}` },
  };
}

function queueEntry(taskId: string): IntegrationQueueEntry {
  return {
    id: `queue-${taskId}`,
    sequence: 1,
    taskId,
    attemptId: `att_${taskId}`,
    taskRevision: `revision-${taskId}`,
    branch: `task/${taskId}/attempt-1`,
    baseRevision: "base",
    status: "COMPLETED",
    enqueuedAt: clock(),
  };
}

function clock(): string {
  return "2026-01-01T00:00:00.000Z";
}
