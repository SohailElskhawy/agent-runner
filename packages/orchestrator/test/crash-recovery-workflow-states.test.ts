import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import type { CrashRecovery, RecoveryOutcome } from "../src/index.js";
import { createCrashRecovery, ORCHESTRATION_EVENTS } from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  FakeVerificationEngine,
  failedVerificationRun,
  passedVerificationRun,
} from "./fixtures.js";
import type { VerificationResponse } from "./fixtures.js";

const taskId = "M001";
const attemptId = "att_M001_1";
const change = {
  path: "src/utils.ts",
  content: "export const add = (a: number, b: number): number => a + b;\n",
};

let directory: string;
let repoPath: string;
let worktreesDir: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: ReturnType<typeof createGitManager>;
let baseRevision: string;
let recovery: CrashRecovery;

function wireRecovery(
  verification?: VerificationResponse | undefined,
): void {
  recovery = createCrashRecovery({
    store,
    git,
    verification: new FakeVerificationEngine(
      verification ?? ((input) => passedVerificationRun(input)),
    ),
    verificationChecks: [
      { name: "typecheck", executable: "node", args: ["--version"] },
      { name: "unit", executable: "node", args: ["--version"] },
    ],
    projectRoot: repoPath,
    worktreesDir,
  });
}

async function seedTask(status: Task["status"]): Promise<void> {
  await store.putTask(createTask({ id: taskId, status }));
}

function runningAttempt(): Attempt {
  return {
    id: attemptId,
    taskId,
    number: 1,
    status: "RUNNING",
    agent: "fake-agent",
    baseRevision,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function worktreePathFor(): string {
  return join(worktreesDir, taskId, "attempt-1");
}

async function createInterruptedWorktree(): Promise<string> {
  const branch = `task/${taskId}/attempt-1`;
  const path = worktreePathFor();
  await git.createBranch(repoPath, branch);
  await git.createWorktree(repoPath, path, branch);
  return path;
}

async function storedTask(): Promise<Task> {
  const task = await store.getTask(taskId);
  if (task === null) {
    throw new Error(`task "${taskId}" not found in store`);
  }
  return task;
}

async function storedAttempt(): Promise<Attempt> {
  const attempt = await store.getAttempt(attemptId);
  if (attempt === null) {
    throw new Error(`attempt "${attemptId}" not found in store`);
  }
  return attempt;
}

function expectOutcomeKind(
  outcome: RecoveryOutcome,
  kind: "safe-to-retry" | "requires-reconciliation" | "requires-human",
): asserts outcome is Extract<
  RecoveryOutcome,
  { kind: "safe-to-retry" | "requires-reconciliation" | "requires-human" }
> {
  if (outcome.kind !== kind) {
    throw new Error(
      `expected a "${kind}" recovery outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

describe("CrashRecovery classification of canonical workflow states", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m012b-"));
    repoPath = join(directory, "project repo");
    worktreesDir = join(directory, "worktrees");
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
    wireRecovery();
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("classifies a PLANNING interruption with a clean worktree as safe to retry", async () => {
    const path = await createInterruptedWorktree();
    await seedTask("PLANNING");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "safe-to-retry");
    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("FAILED");
    expect(existsSync(path)).toBe(false);
  });

  it("classifies a PLANNING interruption whose worktree was never created as safe to retry", async () => {
    await seedTask("PLANNING");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "safe-to-retry");
    expect((await storedTask()).status).toBe("READY");
    expect(existsSync(worktreePathFor())).toBe(false);
  });

  it("classifies a PLAN_REVIEW interruption with a clean worktree as safe to retry", async () => {
    const path = await createInterruptedWorktree();
    await seedTask("PLAN_REVIEW");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "safe-to-retry");
    expect((await storedTask()).status).toBe("READY");
    expect(existsSync(path)).toBe(false);
  });

  it("preserves uncommitted implementation changes after a CODE_REVIEW interruption", async () => {
    const path = await createInterruptedWorktree();
    mkdirSync(join(path, "src"), { recursive: true });
    await writeFile(join(path, change.path), change.content);
    await seedTask("CODE_REVIEW");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-reconciliation");
    expect((await storedTask()).status).toBe("BLOCKED");
    expect((await storedAttempt()).status).toBe("FAILED");
    expect(existsSync(path)).toBe(true);
    const events = await store.listEvents({ taskId });
    expect(
      events.some((event) => event.type === ORCHESTRATION_EVENTS.recoveryReconciled),
    ).toBe(true);
  });

  it("escalates an inconsistent attempt state during PLANNING to NEEDS_HUMAN", async () => {
    await seedTask("PLANNING");
    await store.putAttempt({
      ...runningAttempt(),
      status: "FAILED",
      failure: { kind: "error", message: "stale" },
    });

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-human");
    expect((await storedTask()).status).toBe("NEEDS_HUMAN");
  });

  it("reconciles unfinished tasks in every canonical workflow stage state", async () => {
    const path = await createInterruptedWorktree();
    await seedTask("PLAN_REVIEW");
    await store.putAttempt(runningAttempt());

    const outcomes = await recovery.reconcileUnfinished();

    expect(outcomes).toHaveLength(1);
    expectOutcomeKind(outcomes[0] as RecoveryOutcome, "safe-to-retry");
    expect((await storedTask()).status).toBe("READY");
    expect(existsSync(path)).toBe(false);
  });

  it("keeps treating READY and DONE tasks as needing no recovery", async () => {
    await seedTask("READY");
    expect((await recovery.reconcileTask(taskId)).kind).toBe("no-op");

    await seedTask("DONE");
    expect((await recovery.reconcileTask(taskId)).kind).toBe("no-op");
  });

  it("does not fabricate verification success for a VERIFYING interruption", async () => {
    const path = await createInterruptedWorktree();
    mkdirSync(join(path, "src"), { recursive: true });
    await writeFile(join(path, change.path), change.content);
    await git.stageAll(path);
    await seedTask("VERIFYING");
    await store.putAttempt(runningAttempt());

    wireRecovery((input) => failedVerificationRun(input, "unit", "expected failure"));

    const outcome = await recovery.reconcileTask(taskId);

    expect(outcome.kind).toBe("failed");
    expect((await storedTask()).status).toBe("FAILED");
  });
});
