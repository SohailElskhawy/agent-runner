import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import { createGitManager, type GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore, type RunnerStore } from "@agentic-dev-runner/persistence";
import { createNodeProcessRunner, type ProcessRunner } from "@agentic-dev-runner/platform";
import type { VerificationEngine } from "@agentic-dev-runner/verification";
import {
  createIntegrationQueueProcessor,
  ORCHESTRATION_EVENTS,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  passedVerificationRun,
  runFixtureGit,
  writeChangeAt,
} from "./fixtures.js";

const taskId = "M050";
const attemptId = `att_${taskId}_1`;

describe("Real Git Abandoned Integration Recovery", () => {
  let directory: string;
  let repoPath: string;
  let worktreesDir: string;
  let dbPath: string;
  let runner: ProcessRunner;
  let store: RunnerStore;
  let git: GitManager;
  let baseBranch: string;
  let baseRevision: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-real-git-"));
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

    baseBranch = (await runFixtureGit(runner, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    await store.putProject(createProject());
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("settles an already integrated entry with durable verification without replaying merge or rerunning verification", async () => {
    // 1. Create a task branch and commit with real git
    const branch = `task/${taskId}/attempt-1`;
    await git.createBranch(repoPath, branch);
    await runFixtureGit(runner, repoPath, ["checkout", branch]);
    writeChangeAt(repoPath, "file.txt", "task changes\n");
    await runFixtureGit(runner, repoPath, ["add", "file.txt"]);
    await runFixtureGit(runner, repoPath, ["commit", "-m", "task commit"]);
    const taskRevision = await git.resolveBranchRevision(repoPath, branch);
    await runFixtureGit(runner, repoPath, ["checkout", baseBranch]);

    // Fast-forward main to taskRevision so it is ALREADY integrated
    await git.integrateBranch(repoPath, branch);
    const headRevision = await git.resolveHeadRevision(repoPath);
    expect(headRevision).toBe(taskRevision);

    // 2. Set up store with INTEGRATING task and queue entry
    const task = createTask({ id: taskId, status: "INTEGRATING" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    await store.enqueueIntegrationQueueEntry({
      taskId,
      attemptId,
      taskRevision,
      branch,
      baseRevision,
      enqueuedAt: "2026-01-01T00:00:01.000Z",
    });
    const claimed = await store.claimNextIntegrationQueueEntry("2026-01-01T00:00:02.000Z");
    expect(claimed?.status).toBe("INTEGRATING");

    // Persist durable passing verification matching the integrated head
    await store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.integrationVerificationCompleted,
        taskId,
        payload: {
          attemptId,
          revision: headRevision,
          status: "PASSED",
          checks: [],
        },
        occurredAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    let verificationRan = 0;
    const verification: VerificationEngine = {
      run: async () => {
        verificationRan += 1;
        throw new Error("must not rerun verification");
      },
    };

    const processor = createIntegrationQueueProcessor({
      store,
      git,
      verification,
      verificationChecks: [{ name: "unit", executable: "node" }],
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await processor.recoverAbandoned();
    expect(outcomes[0]?.kind).toBe("processed");
    expect(verificationRan).toBe(0);
    expect((await store.getTask(taskId))?.status).toBe("DONE");
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe("COMPLETED");
  });

  it("recovers an already integrated entry with missing verification by verifying and settling without merge replay", async () => {
    const branch = `task/${taskId}/attempt-1`;
    await git.createBranch(repoPath, branch);
    await runFixtureGit(runner, repoPath, ["checkout", branch]);
    writeChangeAt(repoPath, "file.txt", "task changes\n");
    await runFixtureGit(runner, repoPath, ["add", "file.txt"]);
    await runFixtureGit(runner, repoPath, ["commit", "-m", "task commit"]);
    const taskRevision = await git.resolveBranchRevision(repoPath, branch);
    await runFixtureGit(runner, repoPath, ["checkout", baseBranch]);

    await git.integrateBranch(repoPath, branch);
    const headRevision = await git.resolveHeadRevision(repoPath);
    expect(headRevision).toBe(taskRevision);

    const task: Task = {
      ...createTask({ id: taskId, status: "INTEGRATING" }),
      definition: {
        ...createTask().definition,
        verification: { required: ["unit"] },
      },
    };
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    await store.enqueueIntegrationQueueEntry({
      taskId,
      attemptId,
      taskRevision,
      branch,
      baseRevision,
      enqueuedAt: "2026-01-01T00:00:01.000Z",
    });
    await store.claimNextIntegrationQueueEntry("2026-01-01T00:00:02.000Z");

    let verificationRan = 0;
    const verification: VerificationEngine = {
      run: async (input) => {
        verificationRan += 1;
        expect(input.cwd).toBe(repoPath);
        return passedVerificationRun(input);
      },
    };

    const processor = createIntegrationQueueProcessor({
      store,
      git,
      verification,
      verificationChecks: [{ name: "unit", executable: "node" }],
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await processor.recoverAbandoned();
    expect(outcomes[0]?.kind).toBe("processed");
    expect(verificationRan).toBe(1);
    expect((await store.getTask(taskId))?.status).toBe("DONE");
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe("COMPLETED");

    // Verify durable evidence was persisted
    const events = await store.listEvents({
      taskId,
      type: ORCHESTRATION_EVENTS.integrationVerificationCompleted,
    });
    expect(events).toHaveLength(1);
  });

  it("requeues and processes a not-integrated entry", async () => {
    const branch = `task/${taskId}/attempt-1`;
    await git.createBranch(repoPath, branch);
    await runFixtureGit(runner, repoPath, ["checkout", branch]);
    writeChangeAt(repoPath, "file.txt", "task changes\n");
    await runFixtureGit(runner, repoPath, ["add", "file.txt"]);
    await runFixtureGit(runner, repoPath, ["commit", "-m", "task commit"]);
    const taskRevision = await git.resolveBranchRevision(repoPath, branch);
    await runFixtureGit(runner, repoPath, ["checkout", baseBranch]);

    // NOT integrated into main yet
    const headRevision = await git.resolveHeadRevision(repoPath);
    expect(headRevision).not.toBe(taskRevision);

    const task: Task = {
      ...createTask({ id: taskId, status: "INTEGRATING" }),
      definition: {
        ...createTask().definition,
        verification: { required: ["unit"] },
      },
    };
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);

    await store.enqueueIntegrationQueueEntry({
      taskId,
      attemptId,
      taskRevision,
      branch,
      baseRevision,
      enqueuedAt: "2026-01-01T00:00:01.000Z",
    });
    await store.claimNextIntegrationQueueEntry("2026-01-01T00:00:02.000Z");

    const verification: VerificationEngine = {
      run: async (input) => passedVerificationRun(input),
    };

    const processor = createIntegrationQueueProcessor({
      store,
      git,
      verification,
      verificationChecks: [{ name: "unit", executable: "node" }],
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await processor.recoverAbandoned();
    expect(outcomes[0]?.kind).toBe("processed");
    expect((await store.getTask(taskId))?.status).toBe("DONE");
    // Main has been fast-forward integrated
    expect(await git.resolveHeadRevision(repoPath)).toBe(taskRevision);
  });

  it("fails closed and retains locks when Git state is ambiguous", async () => {
    const branch = `task/${taskId}/attempt-1`;
    // We record a non-existent task commit and do not create the branch
    const fakeTaskRevision = "0123456789abcdef0123456789abcdef01234567";

    const task = createTask({ id: taskId, status: "INTEGRATING" });
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "test-agent",
      baseRevision,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.putTask(task);
    await store.putAttempt(attempt);
    await store.acquireResourceLocks([{ resource: "lock-ambiguous", taskId }]);

    await store.enqueueIntegrationQueueEntry({
      taskId,
      attemptId,
      taskRevision: fakeTaskRevision,
      branch,
      baseRevision,
      enqueuedAt: "2026-01-01T00:00:01.000Z",
    });
    await store.claimNextIntegrationQueueEntry("2026-01-01T00:00:02.000Z");

    const verification: VerificationEngine = {
      run: async (input) => passedVerificationRun(input),
    };

    const processor = createIntegrationQueueProcessor({
      store,
      git,
      verification,
      verificationChecks: [{ name: "unit", executable: "node" }],
      projectRoot: repoPath,
      worktreesDir,
    });

    const outcomes = await processor.recoverAbandoned();
    expect(outcomes[0]?.kind).toBe("failed");
    expect((outcomes[0] as { recoveryRequired?: boolean })?.recoveryRequired).toBe(true);

    // Fail-closed invariants: locks retained, task not DONE, queue entry not requeued as PENDING
    expect((await store.getTask(taskId))?.status).toBe("INTEGRATING");
    expect(await store.listResourceLocks()).toHaveLength(1);
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe("INTEGRATING");
  });
});
