import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { TaskId } from "@agentic-dev-runner/core";
import {
  OrchestrationError,
  type CrashRecovery,
  type RecoveryOutcome,
  type SingleTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { SingleTaskOrchestrator } from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { outcomeToRunResult } from "../src/application/runner-app-service.js";
import { runCli } from "../src/run-cli.js";
import {
  captureIo,
  createFixtureAttempt,
  createFixtureProject,
  createFixtureTask,
  temporaryDirectory,
} from "./fixtures.js";
import { executeInitCommand, executeRunCommand, executeStatusCommand, executeInspectCommand } from "../src/commands/execute-commands.js";

class StubOrchestrator implements SingleTaskOrchestrator {
  readonly calls: TaskId[] = [];

  constructor(
    private readonly outcome: SingleTaskRunOutcome,
    private readonly log?: string[],
  ) {}

  async run(taskId: TaskId): Promise<SingleTaskRunOutcome> {
    this.calls.push(taskId);
    this.log?.push(`orchestrator.run:${taskId}`);
    return this.outcome;
  }
}

class RecordingRecovery implements CrashRecovery {
  constructor(
    private readonly log: string[],
    private readonly unfinishedError?: Error,
  ) {}

  async reconcileTask(taskId: TaskId): Promise<RecoveryOutcome> {
    this.log.push(`reconcileTask:${taskId}`);
    return { kind: "no-op", taskId, detail: "stub recovery" };
  }

  async reconcileUnfinished(): Promise<RecoveryOutcome[]> {
    this.log.push("reconcileUnfinished");
    if (this.unfinishedError !== undefined) {
      throw this.unfinishedError;
    }
    return [];
  }
}

class StubRecovery implements CrashRecovery {
  async reconcileTask(taskId: TaskId): Promise<RecoveryOutcome> {
    return { kind: "no-op", taskId, detail: "stub recovery" };
  }

  async reconcileUnfinished(): Promise<RecoveryOutcome[]> {
    return [];
  }
}

const completedOutcome: SingleTaskRunOutcome = {
  kind: "completed",
  taskId: "M001",
  attemptId: "att_M001_1",
  task: createFixtureTask(),
  attempt: createFixtureAttempt(),
  branch: "task/M001/attempt-1",
  worktreePath: "fixtures/worktrees/M001/attempt-1",
  integration: { kind: "fast-forward", revision: "abc1234" },
  cleanup: { kind: "removed" },
};

describe("StoreBackedAppService", () => {
  let directory: string;
  let storePath: string;
  let store: RunnerStore;

  beforeEach(() => {
    directory = temporaryDirectory("agentic-cli-app");
    storePath = directory;
    store = createSqliteRunnerStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function serviceWithOutcome(outcome: SingleTaskRunOutcome) {
    return createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(outcome),
      recovery: new StubRecovery(),
    });
  }

  it("delegates run exactly once to the orchestrator and maps the outcome", async () => {
    const orchestrator = new StubOrchestrator(completedOutcome);
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator,
      recovery: new StubRecovery(),
    });

    const result = await service.run("M001");

    expect(orchestrator.calls).toEqual(["M001"]);
    expect(result.kind).toBe("completed");
  });

  it("reconciles unfinished operations once at startup before any application operation", async () => {
    const log: string[] = [];
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome, log),
      recovery: new RecordingRecovery(log),
    });

    await service.status();
    await service.inspect("M999");
    await service.run("M001");

    expect(log).toEqual([
      "reconcileUnfinished",
      "reconcileTask:M001",
      "orchestrator.run:M001",
    ]);
  });

  it("surfaces startup reconciliation failures through the existing error path", async () => {
    const log: string[] = [];
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome, log),
      recovery: new RecordingRecovery(
        log,
        new OrchestrationError("startup reconciliation failed"),
      ),
    });

    await expect(service.status()).rejects.toThrow("startup reconciliation failed");
    await expect(service.run("M001")).rejects.toThrow("startup reconciliation failed");
    expect(log.filter((entry) => entry === "reconcileUnfinished")).toHaveLength(1);

    const { io, errors } = captureIo();
    const exitCode = await runCli(["status"], { io, servicesFactory: () => service });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("startup reconciliation failed");
    expect(log.filter((entry) => entry === "reconcileUnfinished")).toHaveLength(1);
  });

  it("reads persisted projects, tasks, and attempts for status", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ status: "FAILED" }));
    await store.putAttempt(
      createFixtureAttempt({ status: "FAILED" }),
    );
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
    });

    const status = await service.status();

    expect(status.project?.id).toBe("proj-local");
    expect(status.tasks).toHaveLength(1);
    const task = status.tasks[0];
    expect(task?.status).toBe("FAILED");
    expect(task?.latestAttempt?.status).toBe("FAILED");
  });

  it("inspects persisted attempts, events, and failure information without reconstructing state", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ status: "FAILED" }));
    await store.putAttempt(
      createFixtureAttempt({
        status: "FAILED",
      }),
    );
    await store.appendEvents([
      {
        type: "task.transitioned",
        taskId: "M001",
        payload: { from: "READY", to: "FAILED" },
        occurredAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
    });

    const inspection = await service.inspect("M001");

    expect(inspection).not.toBeNull();
    expect(inspection?.task.status).toBe("FAILED");
    expect(inspection?.attempts).toHaveLength(1);
    expect(inspection?.events).toHaveLength(1);
    expect(inspection?.events[0]?.type).toBe("task.transitioned");
  });

  it("returns null for an unknown task on inspect", async () => {
    await store.initialize();
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
    });

    expect(await service.inspect("M999")).toBeNull();
  });

  it("maps rejected orchestration outcomes to rejected run results", async () => {
    const service = serviceWithOutcome({
      kind: "rejected",
      taskId: "M001",
      reason: 'task "M001" not found',
    });

    const result = await service.run("M001");

    expect(result.kind).toBe("rejected");
    expect(outcomeToRunResult({
      kind: "rejected",
      taskId: "M001",
      reason: "missing",
    }).message).toContain("missing");
  });

  it("renders run results through the command layer with correct exit codes", async () => {
    const { io, lines, errors } = captureIo();
    const service = serviceWithOutcome(completedOutcome);
    const exitCode = await executeRunCommand("M001", service, io);
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("completed");

    const failedService = serviceWithOutcome({
      kind: "failed",
      taskId: "M001",
      task: createFixtureTask(),
      attempt: createFixtureAttempt({ status: "FAILED" }),
      reason: "verification failed",
    });
    const failedCapture = captureIo();
    const failedExit = await executeRunCommand("M001", failedService, failedCapture.io);
    expect(failedExit).toBe(1);
    expect(failedCapture.errors.join("\n")).toContain("verification failed");

    const cancelledCapture = captureIo();
    const cancelledService = serviceWithOutcome({
      kind: "cancelled",
      taskId: "M001",
      task: createFixtureTask(),
      attempt: createFixtureAttempt({ status: "CANCELLED" }),
      reason: "user cancelled",
    });
    const cancelledExit = await executeRunCommand("M001", cancelledService, cancelledCapture.io);
    expect(cancelledExit).toBe(1);

    const rejectedCapture = captureIo();
    const rejectedService = serviceWithOutcome({
      kind: "rejected",
      taskId: "M001",
      reason: "not runnable",
    });
    const rejectedExit = await executeRunCommand("M001", rejectedService, rejectedCapture.io);
    expect(rejectedExit).toBe(1);
    expect(errors.length + rejectedCapture.errors.length).toBeGreaterThan(0);
  });

  it("status command renders persisted status with zero exit", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask());
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
    });
    const { io, lines } = captureIo();

    const exitCode = await executeStatusCommand(service, io);

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("[READY]");
  });

  it("inspect command exits non-zero for unknown tasks", async () => {
    await store.initialize();
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
    });
    const { io, errors } = captureIo();

    const exitCode = await executeInspectCommand("M999", service, io);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('task "M999" was not found');
  });

  it("init command initializes the store and renders the state path", async () => {
    const service = createStoreBackedAppService({
      storePath: ":memory:",
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
    });
    const { io, lines } = captureIo();

    const exitCode = await executeInitCommand(service, io);

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain(":memory:");
  });
});

