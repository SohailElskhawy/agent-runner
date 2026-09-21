import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { TaskId } from "@agentic-dev-runner/core";
import type {
  CrashRecovery,
  ExecutionClaimRecovery,
  IntegrationQueueProcessor,
  RecoveryOutcome,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
  WorktreeRecovery,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import {
  createFixtureProject,
  createFixtureTask,
  temporaryDirectory,
} from "./fixtures.js";

class StubOrchestrator implements SingleTaskOrchestrator {
  async run(): Promise<SingleTaskRunOutcome> {
    throw new Error("not called in this test");
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

class StubAgentRegistry implements AgentRegistry {
  get agentIds(): readonly string[] {
    return [];
  }

  async discoverAgents() {
    return [];
  }
}

describe("Startup recovery observability", () => {
  let directory: string;
  let storePath: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = temporaryDirectory("cli-startup-recovery");
    storePath = `${directory}/runner.db`;
    store = createSqliteRunnerStore({ path: storePath });
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.putTask(createFixtureTask({ id: "M001" }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("records and exposes recovery.startup.* events through inspect", async () => {
    const mockIntegrationRecovery: IntegrationQueueProcessor = {
      processNext: async () => ({ kind: "empty" }),
      recoverAbandoned: async () => [
        {
          kind: "failed",
          entry: {
            id: "q-1",
            sequence: 1,
            taskId: "M001",
            attemptId: "att_M001_1",
            executionId: "exec-1",
            taskRevision: "rev-1",
            branch: "task/M001/attempt-1",
            baseRevision: "base-1",
            enqueuedAt: "2026-01-01T00:00:00.000Z",
            status: "INTEGRATING",
          },
          taskRevision: "rev-1",
          reason: "manual inspection required",
          recoveryRequired: true,
        },
      ],
    };

    const mockExecutionClaimRecovery: ExecutionClaimRecovery = {
      reconcileExpired: async () => [
        {
          kind: "safe-to-retry",
          claim: {
            id: "exec-1",
            taskId: "M001",
            status: "ACTIVE",
            claimedAt: "2026-01-01T00:00:00.000Z",
            leaseExpiresAt: "2026-01-01T00:00:05.000Z",
            recoveryOwnerId: null,
            recoveryExpiresAt: null,
            renewedAt: null,
          },
        },
      ],
    };

    const mockWorktreeRecovery: WorktreeRecovery = {
      reconcileTerminalWorktrees: async () => [
        {
          kind: "retained",
          taskId: "M001",
          path: "/tmp/worktrees/M001/attempt-1",
          reason: "contains uncommitted changes",
        },
      ],
    };

    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(),
      recovery: new StubRecovery(),
      agents: new StubAgentRegistry(),
      integrationRecovery: mockIntegrationRecovery,
      executionClaimRecovery: mockExecutionClaimRecovery,
      worktreeRecovery: mockWorktreeRecovery,
    });

    const inspection = await service.inspect("M001");
    expect(inspection).not.toBeNull();

    const startupEvents = inspection!.events.filter((e) =>
      e.type.startsWith("recovery.startup."),
    );
    expect(startupEvents).toHaveLength(3);

    const integrationEvent = startupEvents.find(
      (e) => e.type === "recovery.startup.integration",
    );
    expect(integrationEvent).toBeDefined();
    expect(integrationEvent?.payload).toEqual({ kind: "failed" });

    const claimEvent = startupEvents.find(
      (e) => e.type === "recovery.startup.execution-claim",
    );
    expect(claimEvent).toBeDefined();
    expect(claimEvent?.payload).toEqual({ kind: "safe-to-retry" });

    const worktreeEvent = startupEvents.find(
      (e) => e.type === "recovery.startup.worktree",
    );
    expect(worktreeEvent).toBeDefined();
    expect(worktreeEvent?.payload).toEqual({ kind: "retained" });

    // Verify stored events also have the taskId
    const storedEvents = await store.listEvents({ taskId: "M001" });
    const storedStartupEvents = storedEvents.filter((e) =>
      e.type.startsWith("recovery.startup."),
    );
    expect(storedStartupEvents).toHaveLength(3);
    expect(storedStartupEvents.every((e) => e.taskId === "M001")).toBe(true);

    // Calling inspect again should be idempotent and not add duplicate startup events
    const secondInspection = await service.inspect("M001");
    const secondEvents = secondInspection!.events.filter((e) =>
      e.type.startsWith("recovery.startup."),
    );
    expect(secondEvents).toHaveLength(3);

    await service.close();
  });

  it("triggers startup reconciliation on status inspection", async () => {
    let integrationCalled = false;
    const mockIntegrationRecovery: Partial<IntegrationQueueProcessor> = {
      recoverAbandoned: async () => {
        integrationCalled = true;
        return [];
      },
    };

    let claimCalled = false;
    const mockExecutionClaimRecovery: Partial<ExecutionClaimRecovery> = {
      reconcileExpired: async () => {
        claimCalled = true;
        return [];
      },
    };

    let worktreeCalled = false;
    const mockWorktreeRecovery: Partial<WorktreeRecovery> = {
      reconcileTerminalWorktrees: async () => {
        worktreeCalled = true;
        return [];
      },
    };

    const service = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store,
      orchestrator: new StubOrchestrator(),
      recovery: new StubRecovery(),
      agents: new StubAgentRegistry(),
      integrationRecovery: mockIntegrationRecovery as IntegrationQueueProcessor,
      executionClaimRecovery: mockExecutionClaimRecovery as ExecutionClaimRecovery,
      worktreeRecovery: mockWorktreeRecovery as WorktreeRecovery,
    });

    const status = await service.status();
    expect(status.tasks).toHaveLength(1);
    expect(integrationCalled).toBe(true);
    expect(claimCalled).toBe(true);
    expect(worktreeCalled).toBe(true);

    await service.close();
  });
});
