import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt } from "@agentic-dev-runner/core";
import {
  createCrashRecovery,
  createExecutionClaimRecovery,
  createIntegrationQueueProcessor,
  createWorktreeRecovery,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  FakeVerificationEngine,
  passedVerificationRun,
  runFixtureGit,
} from "./fixtures.js";

let directory: string;
let repoPath: string;
let worktreesDir: string;
let dbPath: string;
let runner: ProcessRunner;
let git: GitManager;
let baseBranch: string;
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
  directory = mkdtempSync(join(tmpdir(), "adr-restart-e2e-"));
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
  baseBranch = (await runFixtureGit(runner, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
});

afterEach(async () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows
  }
});

describe("Restart-style crash recovery end-to-end", () => {
  it("recovers an abandoned integration and settles expired claims across two application lifetimes", async () => {
    const taskId = "M001";
    const attemptId = "att_M001_1";
    const branch = `task/${taskId}/attempt-1`;
    const worktreePath = join(worktreesDir, taskId, "attempt-1");

    // =========================================================================
    // LIFETIME 1: Task runs, integrates in Git, but crashes before clean settlement
    // =========================================================================
    const store1 = createSqliteRunnerStore({ path: dbPath });
    await store1.initialize();
    await store1.putProject(createProject());
    await store1.putTask(
      createTask({
        id: taskId,
        status: "READY",
      }),
    );

    // Claim task execution
    const claim1 = await store1.claimTaskExecution({
      taskId,
      executionId: "exec-lifetime-1",
      maxParallelism: 1,
      resources: ["shared-resource-1"],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:00:05.000Z",
    });
    expect(claim1.kind).toBe("claimed");

    // Task advances to IMPLEMENTING, attempt 1 is running
    await store1.setTaskStatus(taskId, "IMPLEMENTING", "2026-01-01T00:00:01.000Z");
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "opencode",
      baseRevision,
      startedAt: "2026-01-01T00:00:01.000Z",
    };
    await store1.putAttempt(attempt);

    // Create branch and worktree, commit a change
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
    const changedFilePath = join(worktreePath, "feature.txt");
    writeFileSync(changedFilePath, "implemented feature\n", "utf8");
    await git.stageAll(worktreePath);
    await git.commitStaged(worktreePath, `task ${taskId}: add feature`);
    const taskRevision = (
      await runFixtureGit(runner, worktreePath, ["rev-parse", "HEAD"])
    ).trim();

    // Advance task to INTEGRATING and enqueue integration queue entry
    await store1.setTaskStatus(taskId, "INTEGRATING", "2026-01-01T00:00:02.000Z");
    const queueEntry = await store1.enqueueIntegrationQueueEntry({
      taskId,
      attemptId,
      executionId: "exec-lifetime-1",
      taskRevision,
      branch,
      baseRevision,
      enqueuedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(queueEntry).not.toBeNull();
    const claimedEntry = await store1.claimNextIntegrationQueueEntry("2026-01-01T00:00:02.000Z");
    expect(claimedEntry?.status).toBe("INTEGRATING");

    // In Git, the integration commit merges into baseBranch
    await runFixtureGit(runner, repoPath, ["checkout", baseBranch]);
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", taskRevision]);
    const integratedHead = (
      await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD"])
    ).trim();
    expect(integratedHead).toBe(taskRevision);

    // Also persist durable verification event for the integrated commit
    await store1.appendEvents([
      {
        type: "integration.verification_completed",
        taskId,
        payload: {
          attemptId,
          revision: taskRevision,
          status: "PASSED",
          checks: [
            { name: "typecheck", outcome: "PASSED" },
            { name: "unit", outcome: "PASSED" },
          ],
        },
        occurredAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    // Abrupt crash: close store 1 without clean settlement or lock release
    await store1.close();

    // =========================================================================
    // LIFETIME 2: Application restarts after lease expiry and runs startup recovery
    // =========================================================================
    const now = () => "2026-01-01T00:00:15.000Z"; // lease expired at 00:00:05
    const store2 = createSqliteRunnerStore({ path: dbPath });
    await store2.initialize();

    const verificationEngine = new FakeVerificationEngine((input) => passedVerificationRun(input));
    const crashRecovery2 = createCrashRecovery({
      store: store2,
      git,
      verification: verificationEngine,
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
      now,
    });

    const integrationRecovery2 = createIntegrationQueueProcessor({
      store: store2,
      git,
      verification: verificationEngine,
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
      now,
    });

    const claimRecovery2 = createExecutionClaimRecovery({
      store: store2,
      recovery: crashRecovery2,
      now,
    });

    const worktreeRecovery2 = createWorktreeRecovery({
      store: store2,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    // Run startup recovery sequence
    const integrationOutcomes = await integrationRecovery2.recoverAbandoned();
    expect(integrationOutcomes).toHaveLength(1);
    expect(integrationOutcomes[0]?.kind).toBe("processed");

    const claimOutcomes = await claimRecovery2.reconcileExpired();
    expect(claimOutcomes).toHaveLength(1);
    expect(claimOutcomes[0]?.kind).toBe("terminal-settled");

    const unfinishedOutcomes = await crashRecovery2.reconcileUnfinished();
    expect(unfinishedOutcomes).toHaveLength(0);

    const worktreeOutcomes = await worktreeRecovery2.reconcileTerminalWorktrees();
    expect(worktreeOutcomes).toHaveLength(1);
    expect(worktreeOutcomes[0]?.kind).toBe("absent");

    // =========================================================================
    // POST-RECOVERY INVARIANT VERIFICATION
    // =========================================================================
    // 1. Task status is authoritatively DONE
    const recoveredTask = await store2.getTask(taskId);
    expect(recoveredTask?.status).toBe("DONE");

    // 2. Exactly 1 attempt exists and is SUCCEEDED (no duplicate attempts)
    const attempts = await store2.listAttempts({ taskId });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.id).toBe(attemptId);
    expect(attempts[0]?.status).toBe("SUCCEEDED");

    // 3. Integration queue entry is COMPLETED (no duplicate integration)
    const queueEntries = await store2.listIntegrationQueueEntries({ taskId });
    expect(queueEntries).toHaveLength(1);
    expect(queueEntries[0]?.status).toBe("COMPLETED");

    // 4. Execution claim is COMPLETED and no ACTIVE claims remain
    const activeClaims = await store2.listExecutionClaims({ status: "ACTIVE" });
    expect(activeClaims).toHaveLength(0);
    const allClaims = await store2.listExecutionClaims();
    expect(allClaims).toHaveLength(1);
    expect(allClaims[0]?.status).toBe("COMPLETED");

    // 5. Resource locks are fully released (no orphan locks)
    const locks = await store2.listResourceLocks();
    expect(locks).toHaveLength(0);

    // 6. Worktree is cleanly removed
    expect(existsSync(worktreePath)).toBe(false);

    // 7. Git HEAD is unchanged and points to the integrated commit
    const currentHead = (
      await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD"])
    ).trim();
    expect(currentHead).toBe(taskRevision);

    await store2.close();
  });

  it("recovers an interrupted implementing task with clean worktree and resets for retry", async () => {
    const taskId = "M002";
    const attemptId = "att_M002_1";
    const branch = `task/${taskId}/attempt-1`;
    const worktreePath = join(worktreesDir, taskId, "attempt-1");

    // =========================================================================
    // LIFETIME 1: Task claimed and running, worktree clean at base revision, crashes
    // =========================================================================
    const store1 = createSqliteRunnerStore({ path: dbPath });
    await store1.initialize();
    await store1.putProject(createProject());
    await store1.putTask(
      createTask({
        id: taskId,
        status: "READY",
      }),
    );

    const claim1 = await store1.claimTaskExecution({
      taskId,
      executionId: "exec-lifetime-2",
      maxParallelism: 1,
      resources: ["lock-m002"],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:00:05.000Z",
    });
    expect(claim1.kind).toBe("claimed");

    await store1.setTaskStatus(taskId, "IMPLEMENTING", "2026-01-01T00:00:01.000Z");
    await store1.putAttempt({
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "opencode",
      baseRevision,
      startedAt: "2026-01-01T00:00:01.000Z",
    });

    // Create clean worktree at base revision
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);

    // Crash without settlement
    await store1.close();

    // =========================================================================
    // LIFETIME 2: Startup recovery runs
    // =========================================================================
    const now = () => "2026-01-01T00:00:15.000Z";
    const store2 = createSqliteRunnerStore({ path: dbPath });
    await store2.initialize();

    const verificationEngine = new FakeVerificationEngine((input) => passedVerificationRun(input));
    const crashRecovery2 = createCrashRecovery({
      store: store2,
      git,
      verification: verificationEngine,
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
      now,
    });

    const claimRecovery2 = createExecutionClaimRecovery({
      store: store2,
      recovery: crashRecovery2,
      now,
    });

    const worktreeRecovery2 = createWorktreeRecovery({
      store: store2,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    // Reconcile expired claims
    const claimOutcomes = await claimRecovery2.reconcileExpired();
    expect(claimOutcomes).toHaveLength(1);
    expect(claimOutcomes[0]?.kind).toBe("safe-to-retry");

    const worktreeOutcomes = await worktreeRecovery2.reconcileTerminalWorktrees();
    expect(worktreeOutcomes).toHaveLength(0);

    // =========================================================================
    // POST-RECOVERY INVARIANTS
    // =========================================================================
    // 1. Task is reset to READY for retry
    const recoveredTask = await store2.getTask(taskId);
    expect(recoveredTask?.status).toBe("READY");

    // 2. Attempt 1 is marked FAILED (interrupted)
    const attempts = await store2.listAttempts({ taskId });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("FAILED");

    // 3. Claim is settled FAILED, no active claims
    const activeClaims = await store2.listExecutionClaims({ status: "ACTIVE" });
    expect(activeClaims).toHaveLength(0);

    // 4. Locks are released
    const locks = await store2.listResourceLocks();
    expect(locks).toHaveLength(0);

    await store2.close();
  });
});
