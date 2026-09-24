import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { Task, TaskId } from "@agentic-dev-runner/core";
import {
  OrchestrationError,
  type CrashRecovery,
  type RecoveryOutcome,
  type SingleTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { SingleTaskOrchestrator } from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentAvailability, AgentRegistry } from "@agentic-dev-runner/agents";
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
import { executeInitCommand, executeRunCommand, executeRetryCommand, executeStatusCommand, executeInspectCommand } from "../src/commands/execute-commands.js";

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

class StubUnattendedScheduler {
  readonly runCalls: { maxParallelism?: number | undefined }[] = [];

  constructor(private readonly kind: "quiescent" | "blocked") {}

  async run(options: { maxParallelism?: number } = {}) {
    this.runCalls.push(options);
    const failedTaskIds = this.kind === "quiescent" ? [] : ["M002"];
    return {
      kind: this.kind,
      cycles: [{ dispatch: null, integrations: [] }],
      completedTaskIds: ["M001"],
      failedTaskIds,
    };
  }
}

class RecordingAgentRegistry implements AgentRegistry {
  readonly discoverCalls: { count: number } = { count: 0 };
  constructor(private readonly agents: readonly AgentAvailability[] = []) {}

  get agentIds(): readonly string[] {
    return this.agents.map((agent) => agent.id);
  }

  async discoverAgents(): Promise<readonly AgentAvailability[]> {
    this.discoverCalls.count += 1;
    return this.agents;
  }
}

const stubAgents: AgentRegistry = new RecordingAgentRegistry();

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
      agents: stubAgents,
    });
  }

  async function retryFixture(
    options: {
      readonly status?: Task["status"];
      readonly attemptCount?: number;
      readonly approvalRequired?: boolean;
      readonly approvalGrantedAt?: string;
    } = {},
  ) {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(
      createFixtureTask({
        id: "T1",
        status: options.status ?? "FAILED",
        approvalRequired: options.approvalRequired ?? false,
        ...(options.approvalGrantedAt === undefined
          ? {}
          : { approvalGrantedAt: options.approvalGrantedAt }),
      }),
    );
    const attemptCount = options.attemptCount ?? 1;
    for (let number = 1; number <= attemptCount; number += 1) {
      await store.putAttempt(
        createFixtureAttempt({
          id: `att_T1_${String(number)}`,
          taskId: "T1",
          number,
          status: "FAILED",
        }),
      );
    }
    return { service: serviceWithOutcome(completedOutcome), store };
  }

  it("delegates run exactly once to the orchestrator and maps the outcome", async () => {
    const orchestrator = new StubOrchestrator(completedOutcome);
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator,
      recovery: new StubRecovery(),
      agents: stubAgents,
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
      agents: stubAgents,
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
      agents: stubAgents,
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
      agents: stubAgents,
    });

    const status = await service.status();

    expect(status.project?.id).toBe("proj-local");
    expect(status.tasks).toHaveLength(1);
    const task = status.tasks[0];
    expect(task?.status).toBe("FAILED");
    expect(task?.latestAttempt?.status).toBe("FAILED");
  });

  it("grants approval once and records an event", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "T1", approvalRequired: true }));
    const service = serviceWithOutcome(completedOutcome);

    const result = await service.approve("T1");

    expect(result.kind).toBe("granted");
    expect((await store.getTask("T1"))?.approvalGrantedAt).toBeTypeOf("string");
    expect(
      (await store.listEvents({ taskId: "T1", type: "task.approval.granted" })).length,
    ).toBe(1);
    expect((await service.approve("T1")).kind).toBe("already-granted");
  });

  it("rejects approving a task that does not require approval", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "T1" }));
    const service = serviceWithOutcome(completedOutcome);

    const result = await service.approve("T1");

    expect(result.kind).toBe("rejected");
    expect(result.message).toContain("does not require human approval");
  });

  it("status exposes approval requirement and grant state per task", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "T1", approvalRequired: true }));
    await store.putTask(createFixtureTask({ id: "T2" }));
    const service = serviceWithOutcome(completedOutcome);

    expect((await service.status()).tasks.find((task) => task.id === "T1")?.approval).toEqual({
      required: true,
      granted: false,
    });

    await service.approve("T1");

    const status = await service.status();
    expect(status.tasks.find((task) => task.id === "T1")?.approval).toEqual({
      required: true,
      granted: true,
    });
    expect(status.tasks.find((task) => task.id === "T2")?.approval).toBeUndefined();
  });

  it("returns a failed task to READY and records retry events", async () => {
    const { service, store } = await retryFixture();

    const result = await service.retry("T1");

    expect(result.kind).toBe("accepted");
    expect(result.message).toBe('task "T1" returned to READY');
    expect((await store.getTask("T1"))?.status).toBe("READY");
    const events = await store.listEvents({ taskId: "T1" });
    expect(events.some((event) => event.type === "task.retry.requested")).toBe(true);
    expect(
      events.find((event) => event.type === "task.retry.requested")?.payload,
    ).toEqual({ previousStatus: "FAILED", attempts: 1 });
    expect(
      events.find((event) => event.type === "task.transitioned")?.payload,
    ).toEqual({ from: "FAILED", to: "READY" });
  });

  it("returns a needs-human task to READY", async () => {
    const { service, store } = await retryFixture({ status: "NEEDS_HUMAN" });

    const result = await service.retry("T1");

    expect(result.kind).toBe("accepted");
    expect((await store.getTask("T1"))?.status).toBe("READY");
  });

  it("returns a blocked task to READY", async () => {
    const { service, store } = await retryFixture({ status: "BLOCKED" });

    const result = await service.retry("T1");

    expect(result.kind).toBe("accepted");
    expect((await store.getTask("T1"))?.status).toBe("READY");
  });

  it("refuses to retry when the attempt budget is exhausted", async () => {
    const { service, store } = await retryFixture({ attemptCount: 3 });

    const result = await service.retry("T1");

    expect(result.kind).toBe("rejected");
    expect(result.message).toMatch(/attempt budget/);
    expect(result.message).toContain("3/3");
    expect((await store.getTask("T1"))?.status).toBe("FAILED");
  });

  it("refuses to retry an approval-required task before approval", async () => {
    const { service, store } = await retryFixture({ approvalRequired: true });

    const result = await service.retry("T1");

    expect(result.kind).toBe("rejected");
    expect(result.message).toMatch(/agentic approve/);
    expect((await store.getTask("T1"))?.status).toBe("FAILED");
  });

  it("returns an approved approval-required task to READY without clearing the grant", async () => {
    const grantedAt = "2026-01-02T00:00:00.000Z";
    const { service, store } = await retryFixture({
      approvalRequired: true,
      approvalGrantedAt: grantedAt,
    });

    const result = await service.retry("T1");

    expect(result.kind).toBe("accepted");
    const task = await store.getTask("T1");
    expect(task?.status).toBe("READY");
    expect(task?.approvalGrantedAt).toBe(grantedAt);
  });

  it("refuses to retry a task whose status is not retryable", async () => {
    const { service, store } = await retryFixture({ status: "READY" });

    const result = await service.retry("T1");

    expect(result.kind).toBe("rejected");
    expect(result.message).toContain(
      "only FAILED, NEEDS_HUMAN, or BLOCKED tasks can be retried",
    );
    expect((await store.getTask("T1"))?.status).toBe("READY");
  });

  it("refuses to retry an unknown task", async () => {
    await store.initialize();
    const service = serviceWithOutcome(completedOutcome);

    const result = await service.retry("T9");

    expect(result).toEqual({
      kind: "rejected",
      taskId: "T9",
      message: 'task "T9" was not found in runner state',
    });
  });

  it("renders retry results through the command layer with correct exit codes", async () => {
    const { service } = await retryFixture();
    const acceptedCapture = captureIo();

    const acceptedExit = await executeRetryCommand("T1", service, acceptedCapture.io);

    expect(acceptedExit).toBe(0);
    expect(acceptedCapture.lines.join("\n")).toContain('task "T1" returned to READY');
    expect(acceptedCapture.errors).toHaveLength(0);

    const exhausted = await retryFixture({ attemptCount: 3 });
    const rejectedCapture = captureIo();

    const rejectedExit = await executeRetryCommand("T1", exhausted.service, rejectedCapture.io);

    expect(rejectedExit).toBe(1);
    expect(rejectedCapture.errors.join("\n")).toContain("attempt budget");
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
      agents: stubAgents,
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
      agents: stubAgents,
    });

    expect(await service.inspect("M999")).toBeNull();
  });

  it("delegates unattended runs to the application scheduler with the requested capacity", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001", status: "DONE" }));
    await store.putTask(createFixtureTask({ id: "M002", status: "READY" }));
    const scheduler = new StubUnattendedScheduler("quiescent");
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
      agents: stubAgents,
      scheduler: scheduler as unknown as never,
    });

    const result = await service.runUnattended({ maxParallelism: 3 });

    expect(scheduler.runCalls).toEqual([{ maxParallelism: 3 }]);
    expect(result.kind).toBe("completed");
    expect(result.message).toContain("quiescence");
    expect(result.message).toContain("1 DONE");
    expect(result.message).toContain("1 READY");
  });

  it("reports a blocked unattended run as failed with the final persisted state", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001", status: "DONE" }));
    await store.putTask(createFixtureTask({ id: "M002", status: "BLOCKED" }));
    const scheduler = new StubUnattendedScheduler("blocked");
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
      agents: stubAgents,
      scheduler: scheduler as unknown as never,
    });

    const result = await service.runUnattended();

    expect(scheduler.runCalls).toEqual([{}]);
    expect(result.kind).toBe("failed");
    expect(result.message).toContain("blocked");
    expect(result.message).toContain("1 DONE");
    expect(result.message).toContain("1 BLOCKED");
  });

  it("status exposes the scheduler-aware project snapshot derived from persisted state", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001", status: "READY" }));
    await store.putTask(createFixtureTask({ id: "M002", status: "FAILED" }));
    await store.putTask(createFixtureTask({ id: "M003", status: "DONE" }));
    await store.putTask(createFixtureTask({ id: "M004", status: "READY" }));
    const claimed = await store.claimTaskExecution({
      taskId: "M001",
      executionId: "exec-1",
      maxParallelism: 2,
      resources: [],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2999-01-01T00:01:00.000Z",
    });
    expect(claimed.kind).toBe("claimed");
    await store.putAttempt(
      createFixtureAttempt({ id: "att_M003_1", taskId: "M003" }),
    );
    await store.enqueueIntegrationQueueEntry({
      taskId: "M003",
      attemptId: "att_M003_1",
      taskRevision: "rev_M003",
      branch: "task/M003/attempt-1",
      baseRevision: "base",
      enqueuedAt: "2026-01-01T00:00:02.000Z",
    });
    // Turn M004's completed claim into unresolved recovery-required state.
    const recoveryClaim = await store.claimTaskExecution({
      taskId: "M004",
      executionId: "exec-2",
      maxParallelism: 2,
      resources: [],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2999-01-01T00:01:00.000Z",
    });
    expect(recoveryClaim.kind).toBe("claimed");
    await store.setTaskStatus("M004", "NEEDS_HUMAN", "2026-01-01T00:00:03.000Z");
    await store.releaseTaskExecution(
      "exec-2",
      "RECOVERY_REQUIRED",
      "2026-01-01T00:00:03.000Z",
    );

    const status = await serviceWithOutcome(completedOutcome).status();
    const scheduler = status.scheduler;

    expect(scheduler.totalsByState.READY).toBe(1);
    expect(scheduler.totalsByState.FAILED).toBe(1);
    expect(scheduler.totalsByState.DONE).toBe(1);
    expect(scheduler.totalsByState.NEEDS_HUMAN).toBe(1);
    expect(scheduler.activeTaskIds).toEqual([]);
    expect(scheduler.failedTaskIds).toEqual(["M002"]);
    expect(scheduler.blockedTaskIds).toEqual([]);
    expect(scheduler.recoveryRequiredTaskIds).toEqual(["M004"]);
    expect(scheduler.activeClaims.map((claim) => claim.executionId)).toEqual(["exec-1"]);
    expect(scheduler.activeClaims[0]?.taskId).toBe("M001");
    expect(scheduler.recoveryRequiredClaims.map((claim) => claim.executionId)).toEqual(["exec-2"]);
    expect(scheduler.integrationQueue.totalsByStatus.PENDING).toBe(1);
    expect(scheduler.integrationQueue.pendingTaskIds).toEqual(["M003"]);
    expect(scheduler.integrationQueue.integrating).toBeNull();
    expect(scheduler.parallelCapacity).toEqual({
      maxParallelism: 1,
      activeExecutions: 1,
      remainingSlots: 0,
    });
  });

  it("reports capacity usage from active claims when no workflow status is active", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001", status: "READY" }));
    const claimed = await store.claimTaskExecution({
      taskId: "M001",
      executionId: "exec-1",
      maxParallelism: 2,
      resources: [],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2999-01-01T00:01:00.000Z",
    });
    expect(claimed.kind).toBe("claimed");
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
      agents: stubAgents,
      maxParallelism: 2,
    });

    const scheduler = (await service.status()).scheduler;

    expect(scheduler.parallelCapacity).toEqual({
      maxParallelism: 2,
      activeExecutions: 1,
      remainingSlots: 1,
    });
  });

  it("inspect exposes stage runs, verification results, claims, and integration queue history", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001", status: "READY" }));
    const claimed = await store.claimTaskExecution({
      taskId: "M001",
      executionId: "exec-1",
      maxParallelism: 1,
      resources: [],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2999-01-01T00:01:00.000Z",
    });
    expect(claimed.kind).toBe("claimed");
    await store.setTaskStatus("M001", "INTEGRATING", "2026-01-01T00:00:00.000Z");
    await store.putAttempt(
      createFixtureAttempt({ id: "att_M001_1", taskId: "M001" }),
    );
    await store.putStageRun({
      id: "stage_att_M001_1_VERIFY",
      attemptId: "att_M001_1",
      stage: "VERIFY",
      status: "SUCCEEDED",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
    });
    await store.putStageRun({
      id: "stage_att_M001_1_INTEGRATE",
      attemptId: "att_M001_1",
      stage: "INTEGRATE",
      status: "PENDING",
      startedAt: "2026-01-01T00:00:03.000Z",
    });
    await store.appendEvents([
      {
        type: "verification.completed",
        taskId: "M001",
        payload: {
          attemptId: "att_M001_1",
          status: "PASSED",
          checks: [
            {
              id: "ver_1",
              attemptId: "att_M001_1",
              kind: "unit",
              command: ["node"],
              outcome: "PASSED",
            },
          ],
        },
        occurredAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    await store.enqueueIntegrationQueueEntry({
      taskId: "M001",
      attemptId: "att_M001_1",
      taskRevision: "rev_M001",
      branch: "task/M001/attempt-1",
      baseRevision: "base",
      enqueuedAt: "2026-01-01T00:00:03.000Z",
    });

    const inspection = (await serviceWithOutcome(completedOutcome).inspect("M001"))!;

    expect(inspection.attempts[0]?.stages.map((stage) => stage.stage)).toEqual([
      "INTEGRATE",
      "VERIFY",
    ]);
    expect(inspection.attempts[0]?.verification?.status).toBe("PASSED");
    expect(inspection.attempts[0]?.verification?.checks).toEqual([
      { kind: "unit", outcome: "PASSED", message: null },
    ]);
    expect(inspection.claims.map((claim) => claim.executionId)).toEqual(["exec-1"]);
    expect(inspection.claims[0]?.status).toBe("ACTIVE");
    expect(inspection.integrationQueue).toHaveLength(1);
    expect(inspection.integrationQueue[0]?.status).toBe("PENDING");
    expect(inspection.integrationQueue[0]?.taskRevision).toBe("rev_M001");
    // Startup reconciliation records the live claim's liveness durably.
    expect(inspection.recoveryEvents.map((event) => event.type)).toEqual([
      "recovery.startup.execution-claim",
    ]);
    expect(inspection.recoveryEvents[0]?.payload).toEqual({ kind: "live" });
  });

  it("inspect surfaces recovery events and failure reasons when present", async () => {
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001", status: "FAILED" }));
    await store.putAttempt(
      createFixtureAttempt({
        id: "att_M001_1",
        taskId: "M001",
        status: "FAILED",
      }),
    );
    await store.appendEvents([
      {
        type: "recovery.startup.execution-claim",
        taskId: "M001",
        payload: { kind: "safe-to-retry" },
        occurredAt: "2026-01-01T00:00:01.000Z",
      },
      {
        type: "task.transitioned",
        taskId: "M001",
        payload: {
          from: "VERIFYING",
          to: "FAILED",
          failure: { kind: "verification_failed", message: "unit checks failed" },
        },
        occurredAt: "2026-01-01T00:00:02.000Z",
      },
    ]);

    const inspection = (await serviceWithOutcome(completedOutcome).inspect("M001"))!;

    expect(inspection.recoveryEvents).toHaveLength(1);
    expect(inspection.recoveryEvents[0]?.type).toBe("recovery.startup.execution-claim");
    expect(inspection.failureReason).toBe("unit checks failed");
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
      agents: stubAgents,
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
      agents: stubAgents,
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
      agents: stubAgents,
    });
    const { io, lines } = captureIo();

    const exitCode = await executeInitCommand(service, io);

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain(":memory:");
  });

  it("listAgents delegates to the agent registry and maps availability entries without touching runner state", async () => {
    const registry = new RecordingAgentRegistry([
      { id: "opencode", available: true, version: "opencode 1.0.0", reason: null },
      { id: "codex", available: false, version: null, reason: "codex missing" },
    ]);
    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(completedOutcome),
      recovery: new StubRecovery(),
      agents: registry,
    });

    const agents = await service.listAgents();

    expect(registry.discoverCalls.count).toBe(1);
    expect(agents).toEqual([
      { id: "opencode", available: true, version: "opencode 1.0.0", reason: null },
      { id: "codex", available: false, version: null, reason: "codex missing" },
    ]);
  });
});

