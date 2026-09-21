import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import { createGitManager, type GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore, type RunnerStore } from "@agentic-dev-runner/persistence";
import { createNodeProcessRunner, type ProcessRunner } from "@agentic-dev-runner/platform";
import { createWorktreeRecovery } from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  writeChangeAt,
} from "./fixtures.js";

describe("WorktreeRecovery lifecycle", () => {
  let directory: string;
  let repoPath: string;
  let worktreesDir: string;
  let dbPath: string;
  let runner: ProcessRunner;
  let store: RunnerStore;
  let git: GitManager;
  let baseRevision: string;

  const taskId = "M049";
  const attemptNumber = 1;
  const attemptId = `att_${taskId}_${attemptNumber}`;
  const branch = `task/${taskId}/attempt-${attemptNumber}`;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-worktree-recovery-"));
    repoPath = join(directory, "repo");
    worktreesDir = join(directory, "worktrees");
    dbPath = join(directory, "state.db");
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

  it("safely removes a clean worktree for a terminal task with settled claim", async () => {
    const worktreePath = join(worktreesDir, taskId, `attempt-${attemptNumber}`);
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);

    const task: Task = createTask({ id: taskId, status: "DONE" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "SUCCEEDED",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    const recovery = createWorktreeRecovery({
      store,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await recovery.reconcileTerminalWorktrees();
    expect(outcomes).toEqual([
      { kind: "removed", taskId, path: worktreePath },
    ]);
    expect(await git.worktreeExists(repoPath, worktreePath)).toBe(false);
  });

  it("retains the worktree when an ACTIVE execution claim exists", async () => {
    const worktreePath = join(worktreesDir, taskId, `attempt-${attemptNumber}`);
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);

    const task: Task = createTask({ id: taskId, status: "READY" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    // Active claim in store
    const claimed = await store.claimTaskExecution({
      taskId,
      executionId: "exec-live",
      maxParallelism: 1,
      resources: ["res1"],
      claimedAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    });
    expect(claimed.kind).toBe("claimed");
    await store.setTaskStatus(taskId, "DONE", "2026-01-01T00:00:01.000Z");

    const recovery = createWorktreeRecovery({
      store,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await recovery.reconcileTerminalWorktrees();
    expect(outcomes).toEqual([
      { kind: "retained", taskId, path: worktreePath, reason: "live-execution" },
    ]);
    expect(await git.worktreeExists(repoPath, worktreePath)).toBe(true);
  });

  it("retains the worktree when unresolved integration queue entries exist", async () => {
    const worktreePath = join(worktreesDir, taskId, `attempt-${attemptNumber}`);
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);

    const task: Task = createTask({ id: taskId, status: "DONE" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "SUCCEEDED",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    await store.enqueueIntegrationQueueEntry({
      taskId,
      attemptId,
      taskRevision: baseRevision,
      branch,
      baseRevision,
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    });

    const recovery = createWorktreeRecovery({
      store,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await recovery.reconcileTerminalWorktrees();
    expect(outcomes).toEqual([
      { kind: "retained", taskId, path: worktreePath, reason: "integration-pending" },
    ]);
    expect(await git.worktreeExists(repoPath, worktreePath)).toBe(true);
  });

  it("retains a dirty worktree and fails closed", async () => {
    const worktreePath = join(worktreesDir, taskId, `attempt-${attemptNumber}`);
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
    // Introduce uncommitted change
    writeChangeAt(worktreePath, "dirty.txt", "uncommitted\n");

    const task: Task = createTask({ id: taskId, status: "FAILED" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "FAILED",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    const recovery = createWorktreeRecovery({
      store,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await recovery.reconcileTerminalWorktrees();
    expect(outcomes).toEqual([
      { kind: "retained", taskId, path: worktreePath, reason: "dirty-or-ambiguous" },
    ]);
    expect(await git.worktreeExists(repoPath, worktreePath)).toBe(true);
  });

  it("reports absent idempotently when worktree does not exist", async () => {
    const worktreePath = join(worktreesDir, taskId, `attempt-${attemptNumber}`);

    const task: Task = createTask({ id: taskId, status: "DONE" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "SUCCEEDED",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    const recovery = createWorktreeRecovery({
      store,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await recovery.reconcileTerminalWorktrees();
    expect(outcomes).toEqual([
      { kind: "absent", taskId, path: worktreePath },
    ]);
  });

  it("performs repeated recovery idempotently without corruption", async () => {
    const worktreePath = join(worktreesDir, taskId, `attempt-${attemptNumber}`);
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);

    const task: Task = createTask({ id: taskId, status: "DONE" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: attemptNumber,
      status: "SUCCEEDED",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    const recovery = createWorktreeRecovery({
      store,
      git,
      projectRoot: repoPath,
      worktreesDir,
    });

    const first = await recovery.reconcileTerminalWorktrees();
    expect(first).toEqual([
      { kind: "removed", taskId, path: worktreePath },
    ]);

    const second = await recovery.reconcileTerminalWorktrees();
    expect(second).toEqual([
      { kind: "absent", taskId, path: worktreePath },
    ]);
  });
});
