import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt } from "@agentic-dev-runner/core";
import { createCrashRecovery } from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  FakeVerificationEngine,
  passedVerificationRun,
} from "./fixtures.js";

const taskId = "M001";
const attemptId = "att_M001_1";

let directory: string;
let repoPath: string;
let worktreesDir: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let baseRevision: string;

function verificationChecks(): [
  { name: string; executable: string; args: string[] },
  { name: string; executable: string; args: string[] },
] {
  return [
    { name: "typecheck", executable: "node", args: ["--version"] },
    { name: "unit", executable: "node", args: ["--version"] },
  ];
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "adr-stale-recovery-"));
  repoPath = join(directory, "repo");
  worktreesDir = join(directory, "worktrees");
  dbPath = join(directory, "runner.db");
  runner = createNodeProcessRunner();
  git = createGitManager({ runner });
  baseRevision = await createFixtureRepository({
    runner,
    repositoryPath: repoPath,
    agentsMarkdown: AGENTS_MARKDOWN,
  });
  store = createSqliteRunnerStore({ path: dbPath });
  await store.initialize();
  await store.putProject(createProject());
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("CrashRecovery stale recovery-owner rejection", () => {
  it("rejects mutations when recovery ownership has transferred to another recovery actor", async () => {
    // 1. Setup task and claim
    const task = createTask({ id: taskId, status: "READY" });
    await store.putTask(task);
    const claimResult = await store.claimTaskExecution({
      taskId,
      executionId: "exec-1",
      maxParallelism: 1,
      resources: [taskId],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:00:05.000Z",
    });
    expect(claimResult.kind).toBe("claimed");
    const executionId = "exec-1";

    // Advance task to IMPLEMENTING with running attempt
    await store.setTaskStatus(taskId, "IMPLEMENTING", "2026-01-01T00:00:01.000Z");
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:01.000Z",
    };
    await store.putAttempt(attempt);

    // 2. Recovery A acquires recovery ownership
    const acquiredA = await store.claimExpiredExecutionRecovery(
      executionId,
      "recovery-A",
      "2026-01-01T00:00:10.000Z", // claim lease expired at 00:00:05
      "2026-01-01T00:00:20.000Z", // expires at 00:00:20
    );
    expect(acquiredA).toBe(true);

    // 3. Recovery A ownership expires, and Recovery B acquires recovery ownership
    const acquiredB = await store.claimExpiredExecutionRecovery(
      executionId,
      "recovery-B",
      "2026-01-01T00:00:25.000Z", // Recovery A expired at 00:00:20
      "2026-01-01T00:00:35.000Z",
    );
    expect(acquiredB).toBe(true);

    // 4. Recovery A attempts reconcileTaskOwned
    const engine = new FakeVerificationEngine((input) => passedVerificationRun(input));
    const recoveryA = createCrashRecovery({
      store,
      git,
      verification: engine,
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
      now: () => "2026-01-01T00:00:26.000Z",
    });

    // Attempting reconcileTaskOwned as recovery-A must fail because recovery-B is now the owner
    await expect(
      recoveryA.reconcileTaskOwned!(taskId, executionId, "recovery-A"),
    ).rejects.toThrow(/Recovery ownership is no longer current/);

    // 5. Verify no authoritative state was mutated by stale Recovery A
    const persistedTask = await store.getTask(taskId);
    expect(persistedTask?.status).toBe("IMPLEMENTING");

    const attempts = await store.listAttempts({ taskId });
    expect(attempts[0]?.status).toBe("RUNNING");

    const events = await store.listEvents({ taskId });
    expect(events.filter((e) => e.type.startsWith("recovery."))).toHaveLength(0);
  });

  it("rejects mutations when recovery ownership has expired without another actor acquiring it", async () => {
    // 1. Setup task and claim
    const task = createTask({ id: taskId, status: "READY" });
    await store.putTask(task);
    const claimResult = await store.claimTaskExecution({
      taskId,
      executionId: "exec-2",
      maxParallelism: 1,
      resources: [taskId],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:00:05.000Z",
    });
    expect(claimResult.kind).toBe("claimed");
    const executionId = "exec-2";

    // Advance task to VERIFYING with running attempt
    await store.setTaskStatus(taskId, "VERIFYING", "2026-01-01T00:00:01.000Z");
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:01.000Z",
    };
    await store.putAttempt(attempt);

    // 2. Recovery A acquires recovery ownership for 5 seconds (until 00:00:15)
    const acquiredA = await store.claimExpiredExecutionRecovery(
      executionId,
      "recovery-A",
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:15.000Z",
    );
    expect(acquiredA).toBe(true);

    // 3. Time passes to 00:00:20 (ownership expired)
    const engine = new FakeVerificationEngine((input) => passedVerificationRun(input));
    const recoveryA = createCrashRecovery({
      store,
      git,
      verification: engine,
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
      now: () => "2026-01-01T00:00:20.000Z",
    });

    await expect(
      recoveryA.reconcileTaskOwned!(taskId, executionId, "recovery-A"),
    ).rejects.toThrow(/Recovery ownership is no longer current/);

    // Authoritative state untouched
    const persistedTask = await store.getTask(taskId);
    expect(persistedTask?.status).toBe("VERIFYING");
    const attempts = await store.listAttempts({ taskId });
    expect(attempts[0]?.status).toBe("RUNNING");
  });

  it("rejects settlement and lock release when recovery owner is expired or transferred", async () => {
    // 1. Setup task and claim with resource locks
    const task = createTask({ id: taskId, status: "READY" });
    await store.putTask(task);
    const claimResult = await store.claimTaskExecution({
      taskId,
      executionId: "exec-3",
      maxParallelism: 1,
      resources: ["resource-lock-1"],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:00:05.000Z",
    });
    expect(claimResult.kind).toBe("claimed");
    const executionId = "exec-3";

    // Verify lock is held
    const initialLocks = await store.listResourceLocks();
    expect(initialLocks).toHaveLength(1);
    expect(initialLocks[0]?.resource).toBe("resource-lock-1");

    // 2. Recovery A claims recovery ownership until 00:00:15
    const acquiredA = await store.claimExpiredExecutionRecovery(
      executionId,
      "recovery-A",
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:15.000Z",
    );
    expect(acquiredA).toBe(true);

    // 3. At 00:00:20, Recovery A attempts to settle via releaseRecoveredTaskExecution
    const settledStale = await store.releaseRecoveredTaskExecution(
      executionId,
      "recovery-A",
      "FAILED",
      "2026-01-01T00:00:20.000Z",
    );
    expect(settledStale).toBe(false);

    // Verify claim is still ACTIVE, recovery_owner is still A, locks are intact
    const claims = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe(executionId);

    const locksAfterStaleSettlement = await store.listResourceLocks();
    expect(locksAfterStaleSettlement).toHaveLength(1);
    expect(locksAfterStaleSettlement[0]?.resource).toBe("resource-lock-1");

    // 4. Recovery B takes ownership
    const acquiredB = await store.claimExpiredExecutionRecovery(
      executionId,
      "recovery-B",
      "2026-01-01T00:00:25.000Z",
      "2026-01-01T00:00:35.000Z",
    );
    expect(acquiredB).toBe(true);

    // Stale Recovery A tries again
    const settledAAfterB = await store.releaseRecoveredTaskExecution(
      executionId,
      "recovery-A",
      "FAILED",
      "2026-01-01T00:00:26.000Z",
    );
    expect(settledAAfterB).toBe(false);

    // Current Recovery B settles successfully
    const settledB = await store.releaseRecoveredTaskExecution(
      executionId,
      "recovery-B",
      "COMPLETED",
      "2026-01-01T00:00:27.000Z",
    );
    expect(settledB).toBe(true);

    // Now locks are released and claim is settled
    const activeClaimsAfterB = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(activeClaimsAfterB).toHaveLength(0);
    const finalLocks = await store.listResourceLocks();
    expect(finalLocks).toHaveLength(0);
  });
});
