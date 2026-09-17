/**
 * Interaction tests between the M059a integration-verification evidence and
 * the committed crash-recovery reconciliation: a task whose recorded
 * integration verification did not pass must never be converged to DONE by
 * FAILED/INTEGRATING-status reconciliation, while the pre-existing
 * convergence behavior for states without integration-verification evidence
 * stays unchanged.
 */

import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { NewEvent, RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import { createCrashRecovery } from "../src/crash-recovery.js";
import type { CrashRecovery } from "../src/crash-recovery.js";
import type {
  FailedRecovery,
  NoOpRecovery,
  RecoveryOutcome,
} from "../src/orchestration-outcome.js";
import { ORCHESTRATION_EVENTS } from "../src/orchestration-events.js";
import type { IntegrationVerificationCompletedPayload } from "../src/orchestration-events.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
} from "./fixtures.js";

const taskId = "M001";
const attemptId = `att_${taskId}_1`;
const branch = `task/${taskId}/attempt-1`;
const commitMessage = `task ${taskId}: Add a small utility function`;
const change = {
  path: "src/utils.ts",
  content: "export const add = (a: number, b: number): number => a + b;\n",
};
const BASE_AT = "2026-01-01T00:00:00.000Z";

let directory: string;
let repoPath: string;
let worktreesDirPath: string;
let worktreePath: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let baseRevision: string;
let recovery: CrashRecovery;

function wireRecovery(): void {
  recovery = createCrashRecovery({
    store,
    git,
    verification: {
      run: async () => {
        throw new Error(
          "reconciliation must not need verification in these scenarios",
        );
      },
    },
    verificationChecks: [
      { name: "typecheck", executable: "node", args: ["--version"] },
      { name: "unit", executable: "node", args: ["--version"] },
    ],
    projectRoot: repoPath,
    worktreesDir: worktreesDirPath,
  });
}

function expectNoOp(
  outcome: RecoveryOutcome,
): asserts outcome is NoOpRecovery {
  if (outcome.kind !== "no-op") {
    throw new Error(
      `expected a no-op recovery outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailedRecovery(
  outcome: RecoveryOutcome,
): asserts outcome is FailedRecovery {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed recovery outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectCompletedRecovery(outcome: RecoveryOutcome): void {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed recovery outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function attemptOf(status: Attempt["status"]): Attempt {
  return {
    id: attemptId,
    taskId,
    number: 1,
    status,
    agent: "fake-agent",
    baseRevision,
    startedAt: BASE_AT,
    finishedAt: "2026-01-01T00:00:05.000Z",
  };
}

function attemptStartedEvent(): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.attemptStarted,
    taskId,
    payload: {
      attemptId,
      attemptNumber: 1,
      agent: "fake-agent",
      baseRevision,
    },
    occurredAt: BASE_AT,
  };
}

function commitCreatedEvent(revision: string): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.commitCreated,
    taskId,
    payload: { attemptId, revision, message: commitMessage },
    occurredAt: "2026-01-01T00:00:02.000Z",
  };
}

function integrationCompletedEvent(revision: string): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.integrationCompleted,
    taskId,
    payload: { attemptId, revision, kind: "fast-forward" },
    occurredAt: "2026-01-01T00:00:03.000Z",
  };
}

function integrationVerificationEvent(
  revision: string,
  status: IntegrationVerificationCompletedPayload["status"],
): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.integrationVerificationCompleted,
    taskId,
    payload: {
      attemptId,
      revision,
      status,
      checks: [],
    } satisfies IntegrationVerificationCompletedPayload,
    occurredAt: "2026-01-01T00:00:04.000Z",
  };
}

async function seedIntegratedState(options: {
  taskStatus: Task["status"];
  attemptStatus: Attempt["status"];
  integrationVerificationStatus: IntegrationVerificationCompletedPayload["status"];
  withIntegrationVerificationEvidence: boolean;
}): Promise<string> {
  await store.putTask(createTask({ id: taskId, status: options.taskStatus }));
  await store.putAttempt(attemptOf(options.attemptStatus));
  await git.createBranch(repoPath, branch);
  await git.createWorktree(repoPath, worktreePath, branch);
  const changeTarget = join(worktreePath, change.path);
  mkdirSync(dirname(changeTarget), { recursive: true });
  writeFileSync(changeTarget, change.content);
  await git.stageAll(worktreePath);
  const commitRevision = await git.commitStaged(worktreePath, commitMessage);
  await git.integrateBranch(repoPath, branch);
  const events: NewEvent[] = [
    attemptStartedEvent(),
    commitCreatedEvent(commitRevision),
    integrationCompletedEvent(commitRevision),
  ];
  if (options.withIntegrationVerificationEvidence) {
    events.push(
      integrationVerificationEvent(
        commitRevision,
        options.integrationVerificationStatus,
      ),
    );
  }
  await store.appendEvents(events);
  return commitRevision;
}

async function storedTaskStatus(): Promise<Task["status"]> {
  const task = await store.getTask(taskId);
  if (task === null) {
    throw new Error(`task "${taskId}" not found in store`);
  }
  return task.status;
}

describe("crash recovery with integration-verification evidence", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m059a-recovery-"));
    repoPath = join(directory, "project repo");
    worktreesDirPath = join(directory, "worktrees");
    worktreePath = join(worktreesDirPath, taskId, "attempt-1");
    dbPath = join(directory, "state.db");
    runner = createNodeProcessRunner();
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    git = createGitManager({ runner });
    baseRevision = await createFixtureRepository({
      runner,
      repositoryPath: repoPath,
      agentsMarkdown: AGENTS_MARKDOWN,
    });
    await store.putProject(createProject({ rootPath: repoPath }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps a FAILED task FAILED when its recorded integration verification did not pass", async () => {
    const commitRevision = await seedIntegratedState({
      taskStatus: "FAILED",
      attemptStatus: "FAILED",
      integrationVerificationStatus: "FAILED",
      withIntegrationVerificationEvidence: true,
    });
    wireRecovery();

    const outcome = await recovery.reconcileTask(taskId);

    expectNoOp(outcome);
    expect(outcome.detail).toContain("integration verification");
    expect(outcome.detail).toContain("did not pass");
    expect(outcome.detail).toContain(commitRevision);
    expect(await storedTaskStatus()).toBe("FAILED");

    const attempt = await store.getAttempt(attemptId);
    expect(attempt?.status).toBe("FAILED");
    const events = await store.listEvents({ taskId });
    expect(
      events.filter(
        (event) =>
          event.type === ORCHESTRATION_EVENTS.recoveryReconciled &&
          (event.payload as { outcome?: string }).outcome === "completed",
      ),
    ).toHaveLength(0);
  });

  it("finishes FAILED instead of DONE when an INTEGRATING task already recorded failed integration verification", async () => {
    const commitRevision = await seedIntegratedState({
      taskStatus: "INTEGRATING",
      attemptStatus: "RUNNING",
      integrationVerificationStatus: "FAILED",
      withIntegrationVerificationEvidence: true,
    });
    wireRecovery();

    const outcome = await recovery.reconcileTask(taskId);

    expectCompletedRevisionSeed(commitRevision);
    expectFailedRecovery(outcome);
    expect(outcome.reason).toContain(
      "recorded integration verification evidence shows failure",
    );
    expect(await storedTaskStatus()).toBe("FAILED");
    const attempt = await store.getAttempt(attemptId);
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failure?.kind).toBe("verification_failed");
  });

  it("still converges an integrated FAILED task to DONE when integration verification passed", async () => {
    await seedIntegratedState({
      taskStatus: "FAILED",
      attemptStatus: "FAILED",
      integrationVerificationStatus: "PASSED",
      withIntegrationVerificationEvidence: true,
    });
    wireRecovery();

    const outcome = await recovery.reconcileTask(taskId);

    expectCompletedRecovery(outcome);
    expect(await storedTaskStatus()).toBe("DONE");
  });

  it("still converges an integrated FAILED task to DONE without integration-verification evidence", async () => {
    await seedIntegratedState({
      taskStatus: "FAILED",
      attemptStatus: "FAILED",
      integrationVerificationStatus: "PASSED",
      withIntegrationVerificationEvidence: false,
    });
    wireRecovery();

    const outcome = await recovery.reconcileTask(taskId);

    expectCompletedRecovery(outcome);
    expect(await storedTaskStatus()).toBe("DONE");
  });
});

function expectCompletedRevisionSeed(commitRevision: string): void {
  if (commitRevision.length === 0) {
    throw new Error("fixture integration state was not seeded");
  }
}
