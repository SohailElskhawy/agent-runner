import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attempt, StageRun } from "@agentic-dev-runner/core";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import {
  createAttempt,
  createProject,
  createStageRun,
  createTask,
} from "./fixtures.js";

describe("SqliteRunnerStore", () => {
  let directory: string;
  let dbPath: string;
  let store: RunnerStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-vs004-"));
    dbPath = join(directory, "state.db");
    store = createSqliteRunnerStore({ path: dbPath });
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("initializes schema idempotently across repeated opens", async () => {
    await store.initialize();
    await store.initialize();

    await store.close();
    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      await reopened.initialize();
      expect(await reopened.listProjects()).toEqual([]);
      expect(await reopened.listEvents()).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it("persists and retrieves projects, tasks, and attempts", async () => {
    await store.initialize();
    const project = createProject();
    const task = createTask();
    const attempt = createAttempt();

    await store.putProject(project);
    await store.putTask(task);
    await store.putAttempt(attempt);

    expect(await store.getProject(project.id)).toEqual(project);
    expect(await store.getTask(task.id)).toEqual(task);
    expect(await store.getAttempt(attempt.id)).toEqual(attempt);
  });

  it("round-trips an attempt without optional fields", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());

    const minimal: Attempt = {
      id: "attempt-min",
      taskId: "M001",
      number: 2,
      status: "RUNNING",
      agent: "opencode",
      baseRevision: "abcdef1234567890",
      startedAt: "2026-01-02T00:00:00.000Z",
    };
    await store.putAttempt(minimal);

    expect(await store.getAttempt("attempt-min")).toEqual(minimal);
  });

  it("reopens all persisted state from a new database connection", async () => {
    await store.initialize();
    const project = createProject();
    const task = createTask();
    const attempt = createAttempt();
    await store.putProject(project);
    await store.putTask(task);
    await store.putAttempt(attempt);
    const storedEvents = await store.appendEvents([
      {
        type: "task.created",
        taskId: task.id,
        payload: { title: task.title },
        occurredAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();

      expect(await reopened.getProject(project.id)).toEqual(project);
      expect(await reopened.getTask(task.id)).toEqual(task);
      expect(await reopened.getAttempt(attempt.id)).toEqual(attempt);
      expect(await reopened.listTasks({ projectId: project.id })).toEqual([
        task,
      ]);
      expect(await reopened.listAttempts({ taskId: task.id })).toEqual([
        attempt,
      ]);

      const events = await reopened.listEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(storedEvents[0]);
      expect(await reopened.listEvents({ taskId: task.id })).toEqual(events);
      expect(await reopened.listEvents({ type: "task.created" })).toEqual(
        events,
      );
      expect(
        await reopened.listEvents({ type: "task.started" }),
      ).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  });

  it("reads and updates the current task status", async () => {
    await store.initialize();
    const task = createTask({ status: "READY" });
    await store.putProject(createProject());
    await store.putTask(task);

    expect(await store.getTaskStatus(task.id)).toBe("READY");

    await store.setTaskStatus(task.id, "IMPLEMENTING", "2026-01-01T01:00:00.000Z");

    expect(await store.getTaskStatus(task.id)).toBe("IMPLEMENTING");
    const reloaded = await store.getTask(task.id);
    expect(reloaded?.status).toBe("IMPLEMENTING");
    expect(reloaded?.updatedAt).toBe("2026-01-01T01:00:00.000Z");
    expect(await store.getTaskStatus("unknown-task")).toBeNull();
  });

  it("appends events immutably and preserves order", async () => {
    await store.initialize();
    const task = createTask();
    await store.putProject(createProject());
    await store.putTask(task);

    const first = await store.appendEvents([
      { type: "task.created", taskId: task.id, payload: {}, occurredAt: "2026-01-01T00:00:01.000Z" },
    ]);
    const rest = await store.appendEvents([
      { type: "task.started", taskId: task.id, payload: { attempt: 1 }, occurredAt: "2026-01-01T00:00:02.000Z" },
      { type: "task.blocked", taskId: task.id, payload: { reason: "deps" }, occurredAt: "2026-01-01T00:00:03.000Z" },
    ]);

    const events = await store.listEvents();
    expect(events.map((event) => event.type)).toEqual([
      "task.created",
      "task.started",
      "task.blocked",
    ]);
    expect(events[0]?.id).toBe(first[0]?.id);
    expect(events[0]?.sequence).toBeLessThan(events[1]?.sequence ?? 0);
    expect(events[1]?.sequence).toBeLessThan(events[2]?.sequence ?? 0);
    expect(rest[1]?.sequence).toBe(events[2]?.sequence);
    expect(events[0]?.taskId).toBe(task.id);
  });

  it("commits task status and event writes atomically", async () => {
    await store.initialize();
    const task = createTask({ status: "READY" });
    await store.putProject(createProject());
    await store.putTask(task);

    await store.transaction(async () => {
      await store.setTaskStatus(task.id, "IMPLEMENTING", "2026-01-01T02:00:00.000Z");
      const [event] = await store.appendEvents([
        {
          type: "task.started",
          taskId: task.id,
          payload: { by: "orchestrator" },
          occurredAt: "2026-01-01T02:00:00.000Z",
        },
      ]);
      expect(event?.type).toBe("task.started");
    });

    expect(await store.getTaskStatus(task.id)).toBe("IMPLEMENTING");
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("rolls back task status and event writes when the transaction fails", async () => {
    await store.initialize();
    const task = createTask({ status: "READY" });
    await store.putProject(createProject());
    await store.putTask(task);

    await expect(
      store.transaction(async () => {
        await store.setTaskStatus(task.id, "IMPLEMENTING", "2026-01-01T02:00:00.000Z");
        await store.appendEvents([
          {
            type: "task.started",
            taskId: task.id,
            payload: {},
            occurredAt: "2026-01-01T02:00:00.000Z",
          },
        ]);
        throw new Error("orchestrator crashed mid-transition");
      }),
    ).rejects.toThrow("orchestrator crashed mid-transition");

    expect(await store.getTaskStatus(task.id)).toBe("READY");
    expect(await store.listEvents()).toHaveLength(0);
  });

  it("rolls back partially written events when the transaction fails", async () => {
    await store.initialize();
    const task = createTask();
    await store.putProject(createProject());
    await store.putTask(task);

    await expect(
      store.transaction(async () => {
        await store.appendEvents([
          { type: "task.created", taskId: task.id, payload: {}, occurredAt: "2026-01-01T00:00:01.000Z" },
          { type: "task.started", taskId: task.id, payload: {}, occurredAt: "2026-01-01T00:00:02.000Z" },
        ]);
        throw new Error("second write failed");
      }),
    ).rejects.toThrow("second write failed");

    expect(await store.listEvents()).toHaveLength(0);
  });

  it("round-trips a stage run with all fields", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());
    await store.putAttempt(createAttempt());

    const stageRun = createStageRun({
      failure: { kind: "timeout", message: "stage exceeded 30s" },
      output: { plan: "Step 1. Do the thing.\nStep 2. Verify the thing." },
    });
    await store.putStageRun(stageRun);

    expect(await store.listStageRuns(stageRun.attemptId)).toEqual([stageRun]);
  });

  it("round-trips a failed stage run that preserves agent output", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());
    await store.putAttempt(createAttempt());

    const stageRun = createStageRun({
      status: "FAILED",
      failure: { kind: "error", message: "agent failed: crashed" },
      output: { stdout: "partial plan", stderr: "boom" },
    });
    await store.putStageRun(stageRun);

    expect(await store.listStageRuns(stageRun.attemptId)).toEqual([stageRun]);
  });

  it("round-trips a stage run without optional fields", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());
    await store.putAttempt(createAttempt());

    const minimal: StageRun = {
      id: "stage-run-min",
      attemptId: "attempt-1",
      stage: "VERIFY",
      status: "PENDING",
    };
    await store.putStageRun(minimal);

    expect(await store.listStageRuns("attempt-1")).toEqual([minimal]);
  });

  it("returns stage runs for an attempt in deterministic execution order", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());
    await store.putAttempt(createAttempt());

    const later = createStageRun({
      id: "stage-run-later",
      stage: "VERIFY",
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: "2026-01-01T00:01:10.000Z",
      failure: { kind: "error", message: "tests failed" },
    });
    const earlier = createStageRun({
      id: "stage-run-earlier",
      stage: "IMPLEMENT",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:40.000Z",
    });
    // Insert out of execution order on purpose.
    await store.putStageRun(later);
    await store.putStageRun(earlier);

    const runs = await store.listStageRuns("attempt-1");
    expect(runs.map((run) => run.id)).toEqual([
      "stage-run-earlier",
      "stage-run-later",
    ]);
    expect(runs).toEqual([earlier, later]);
  });

  it("rejects a stage run referencing an unknown attempt", async () => {
    await store.initialize();
    const orphan = createStageRun({ attemptId: "unknown-attempt" });

    await expect(store.putStageRun(orphan)).rejects.toThrow(
      /attempt "unknown-attempt" does not exist/,
    );
    expect(await store.listStageRuns("unknown-attempt")).toEqual([]);
  });

  it("preserves stage runs across reopen", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());
    await store.putAttempt(createAttempt());
    const stageRun = createStageRun({
      failure: { kind: "review_rejected", message: "review feedback" },
    });
    await store.putStageRun(stageRun);
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      expect(await reopened.listStageRuns(stageRun.attemptId)).toEqual([
        stageRun,
      ]);
    } finally {
      await reopened.close();
    }
  });

  it("rejects nested transactions", async () => {
    await store.initialize();
    await expect(
      store.transaction(async () => {
        await store.transaction(async () => undefined);
      }),
    ).rejects.toThrow("Nested transactions are not supported");
  });

  it("rejects operations after close", async () => {
    await store.initialize();
    await store.close();
    await expect(store.getTask("M001")).rejects.toThrow("store is closed");
    await store.close();
  });
});
