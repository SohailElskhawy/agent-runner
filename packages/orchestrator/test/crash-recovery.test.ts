import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import type { NewEvent } from "@agentic-dev-runner/persistence";
import type {
  CrashRecovery,
  RecoveryOutcome,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
} from "../src/index.js";
import {
  createCrashRecovery,
  createSingleTaskOrchestrator,
  ORCHESTRATION_EVENTS,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  agentAppliesChange,
  createFixtureRepository,
  createProject,
  createTask,
  FakeAgentRuntime,
  FakeVerificationEngine,
  failedVerificationRun,
  passedVerificationRun,
  runFixtureGit,
} from "./fixtures.js";
import type { VerificationResponse } from "./fixtures.js";

const taskId = "M001";
const attemptId = "att_M001_1";
const change = {
  path: "utils.ts",
  content: "export const add = (a: number, b: number): number => a + b;\n",
};
const commitMessage = `task ${taskId}: Add a small utility function`;

let directory: string;
let repoPath: string;
let worktreesDir: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let baseRevision: string;
let recovery: CrashRecovery;

type RecoveryOptions = {
  readonly verification?: VerificationResponse | undefined;
};

function verificationChecks(): [
  { name: string; executable: string; args: string[] },
  { name: string; executable: string; args: string[] },
] {
  return [
    { name: "typecheck", executable: "node", args: ["--version"] },
    { name: "unit", executable: "node", args: ["--version"] },
  ];
}

function wireRecovery(options: RecoveryOptions = {}): void {
  const engine = new FakeVerificationEngine(
    options.verification ?? ((input) => passedVerificationRun(input)),
  );
  recovery = createCrashRecovery({
    store,
    git,
    verification: engine,
    verificationChecks: verificationChecks(),
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

function failedAfterIntegrationAttempt(): Attempt {
  return {
    ...runningAttempt(),
    status: "FAILED",
    failure: {
      kind: "error",
      message:
        "failed to persist the integration result for task \"M001\" (original failure: store write failed)",
    },
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
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

function implementationCompletedEvent(
  changedPaths: readonly string[],
): NewEvent {
  return {
    type: ORCHESTRATION_EVENTS.implementationCompleted,
    taskId,
    payload: { attemptId, changedPaths },
    occurredAt: "2026-01-01T00:00:01.000Z",
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

async function createInterruptedWorktree(): Promise<{
  branch: string;
  worktreePath: string;
}> {
  const branch = `task/${taskId}/attempt-1`;
  const worktreePath = join(worktreesDir, taskId, "attempt-1");
  await git.createBranch(repoPath, branch);
  await git.createWorktree(repoPath, worktreePath, branch);
  return { branch, worktreePath };
}

async function commitTaskChange(worktreePath: string): Promise<string> {
  writeFileSync(join(worktreePath, change.path), change.content);
  await git.stageAll(worktreePath);
  return await git.commitStaged(worktreePath, commitMessage);
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

async function headRevision(): Promise<string> {
  const output = await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD"]);
  return output.trim();
}

async function commitsSinceBase(): Promise<number> {
  const output = await runFixtureGit(runner, repoPath, [
    "rev-list",
    "--count",
    `${baseRevision}..HEAD`,
  ]);
  return Number(output.trim());
}

function expectNoOp(outcome: RecoveryOutcome): void {
  if (outcome.kind !== "no-op") {
    throw new Error(
      `expected a no-op recovery outcome but received "${outcome.kind}"`,
    );
  }
}

function expectCompleted(
  outcome: RecoveryOutcome,
): asserts outcome is Extract<RecoveryOutcome, { kind: "completed" }> {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed recovery outcome but received "${outcome.kind}"`,
    );
  }
}

type EscalatedRecovery = Extract<
  RecoveryOutcome,
  {
    kind: "safe-to-retry" | "requires-reconciliation" | "requires-human";
  }
>;

function expectOutcomeKind(
  outcome: RecoveryOutcome,
  kind: EscalatedRecovery["kind"],
): asserts outcome is EscalatedRecovery {
  if (outcome.kind !== kind) {
    throw new Error(
      `expected a "${kind}" recovery outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectCompletedRun(
  outcome: SingleTaskRunOutcome,
): asserts outcome is Extract<SingleTaskRunOutcome, { kind: "completed" }> {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed run outcome but received "${outcome.kind}"`,
    );
  }
}

describe("CrashRecovery", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-vs013-"));
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

  it("treats tasks outside the active execution states as needing no recovery", async () => {
    await seedTask("READY");
    expectNoOp(await recovery.reconcileTask(taskId));

    await seedTask("DONE");
    expectNoOp(await recovery.reconcileTask(taskId));

    expectNoOp(await recovery.reconcileTask("M999"));
  });

  it("requires no recovery when a READY task has no running attempt evidence", async () => {
    await seedTask("READY");
    const outcome = await recovery.reconcileUnfinished();
    expect(outcome).toEqual([]);
  });

  it("preserves uncommitted agent changes after a crash during agent execution", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    writeFileSync(join(worktreePath, change.path), change.content);
    await seedTask("IMPLEMENTING");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-reconciliation");
    expect((await storedTask()).status).toBe("BLOCKED");
    const attempt = await storedAttempt();
    expect(attempt.status).toBe("FAILED");
    expect(attempt.failure?.kind).toBe("error");
    expect(existsSync(worktreePath)).toBe(true);
    expect(readFileSync(join(worktreePath, change.path), "utf8")).toBe(
      change.content,
    );
    const events = await store.listEvents({ taskId });
    expect(
      events.some((event) => event.type === ORCHESTRATION_EVENTS.recoveryReconciled),
    ).toBe(true);
  });

  it("is idempotent when reconciliation already moved the task out of the active state", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    writeFileSync(join(worktreePath, change.path), change.content);
    await seedTask("IMPLEMENTING");
    await store.putAttempt(runningAttempt());

    const first = await recovery.reconcileTask(taskId);
    expectOutcomeKind(first, "requires-reconciliation");

    const second = await recovery.reconcileTask(taskId);
    expectNoOp(second);
    expect((await storedTask()).status).toBe("BLOCKED");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("resets a task interrupted before the agent produced output so it is safe to retry", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    await seedTask("IMPLEMENTING");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "safe-to-retry");
    expect((await storedTask()).status).toBe("READY");
    const attempt = await storedAttempt();
    expect(attempt.status).toBe("FAILED");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("resets a task whose worktree was never created and proves the retry through a full run", async () => {
    await seedTask("IMPLEMENTING");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "safe-to-retry");
    expect((await storedTask()).status).toBe("READY");

    const orchestrator: SingleTaskOrchestrator = createSingleTaskOrchestrator({
      store,
      git,
      agent: new FakeAgentRuntime(agentAppliesChange(change)),
      verification: new FakeVerificationEngine((input) =>
        passedVerificationRun(input),
      ),
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
      agentTimeoutMs: 5_000,
    });

    const runOutcome = await orchestrator.run(taskId);

    expectCompletedRun(runOutcome);
    expect(runOutcome.attemptId).toBe("att_M001_2");
    expect((await storedTask()).status).toBe("DONE");
  });

  it("reruns deterministic verification after a crash during verification and integrates exactly once", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    writeFileSync(join(worktreePath, change.path), change.content);
    await git.stageAll(worktreePath);
    await seedTask("VERIFYING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([
      attemptStartedEvent(),
      implementationCompletedEvent([change.path]),
    ]);

    let verificationRuns = 0;
    wireRecovery({
      verification: (input) => {
        verificationRuns += 1;
        return passedVerificationRun(input);
      },
    });

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect(verificationRuns).toBe(1);
    expect(outcome.integration).toEqual({
      kind: "fast-forward",
      revision: await headRevision(),
    });
    expect((await storedTask()).status).toBe("DONE");
    expect((await storedAttempt()).status).toBe("SUCCEEDED");
    expect(readFileSync(join(repoPath, change.path), "utf8")).toBe(
      change.content,
    );
    expect(await commitsSinceBase()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);

    const events = await store.listEvents({ taskId });
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain(ORCHESTRATION_EVENTS.verificationCompleted);
    expect(eventTypes).toContain(ORCHESTRATION_EVENTS.commitCreated);
    expect(eventTypes).toContain(ORCHESTRATION_EVENTS.integrationCompleted);
    expect(eventTypes).toContain(ORCHESTRATION_EVENTS.recoveryReconciled);
  });

  it("does not fabricate verification success when the rerun fails", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    writeFileSync(join(worktreePath, change.path), change.content);
    await git.stageAll(worktreePath);
    await seedTask("VERIFYING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([implementationCompletedEvent([change.path])]);

    wireRecovery({
      verification: (input) =>
        failedVerificationRun(input, "unit", "expected failure"),
    });

    const outcome = await recovery.reconcileTask(taskId);

    expect(outcome.kind).toBe("failed");
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = await storedAttempt();
    expect(attempt.status).toBe("FAILED");
    expect(attempt.failure?.kind).toBe("verification_failed");
    expect(await headRevision()).toBe(baseRevision);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(repoPath, change.path))).toBe(false);
  });

  it("continues from durably recorded passing verification without rerunning verification", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    writeFileSync(join(worktreePath, change.path), change.content);
    await git.stageAll(worktreePath);
    await seedTask("VERIFYING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([
      attemptStartedEvent(),
      implementationCompletedEvent([change.path]),
      {
        type: ORCHESTRATION_EVENTS.verificationCompleted,
        taskId,
        payload: {
          attemptId,
          status: "PASSED",
          checks: [],
        },
        occurredAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    let verificationRuns = 0;
    wireRecovery({
      verification: (input) => {
        verificationRuns += 1;
        return passedVerificationRun(input);
      },
    });

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect(verificationRuns).toBe(0);
    expect((await storedTask()).status).toBe("DONE");
    expect(await commitsSinceBase()).toBe(1);
  });

  it("applies durably recorded failing verification evidence without fabricating success", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    writeFileSync(join(worktreePath, change.path), change.content);
    await git.stageAll(worktreePath);
    await seedTask("VERIFYING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([
      implementationCompletedEvent([change.path]),
      {
        type: ORCHESTRATION_EVENTS.verificationCompleted,
        taskId,
        payload: {
          attemptId,
          status: "FAILED",
          checks: [],
        },
        occurredAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    const outcome = await recovery.reconcileTask(taskId);

    expect(outcome.kind).toBe("failed");
    expect((await storedTask()).status).toBe("FAILED");
    expect((await storedAttempt()).failure?.kind).toBe("verification_failed");
    expect(await headRevision()).toBe(baseRevision);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("marks a task DONE without integrating again when the exact task commit is already integrated", async () => {
    const { branch, worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", branch]);
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    const commitsBefore = await commitsSinceBase();
    const headBefore = await headRevision();

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect(outcome.integration).toEqual({
      kind: "already-integrated",
      revision: commitRevision,
    });
    expect((await storedTask()).status).toBe("DONE");
    expect((await storedAttempt()).status).toBe("SUCCEEDED");
    expect(await headRevision()).toBe(headBefore);
    expect(await commitsSinceBase()).toBe(commitsBefore);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("detects an already-integrated exact task commit even after later integration work", async () => {
    const { branch, worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", branch]);
    writeFileSync(join(repoPath, "later.txt"), "later integration work\n");
    await git.stageAll(repoPath);
    const laterHead = await git.commitStaged(repoPath, "later integration");
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect(outcome.integration).toEqual({
      kind: "already-integrated",
      revision: commitRevision,
    });
    expect(await headRevision()).toBe(laterHead);
    expect((await storedTask()).status).toBe("DONE");
  });

  it("retries integration exactly once for a not-integrated INTEGRATING task whose state is provably safe", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect(outcome.integration).toEqual({
      kind: "fast-forward",
      revision: commitRevision,
    });
    expect((await storedTask()).status).toBe("DONE");
    expect(await headRevision()).toBe(commitRevision);
    expect(await commitsSinceBase()).toBe(1);

    const repeated = await recovery.reconcileTask(taskId);
    expectNoOp(repeated);
    expect(await headRevision()).toBe(commitRevision);
    expect(await commitsSinceBase()).toBe(1);
  });

  it("does not falsely complete integration when the task branch is missing", async () => {
    const commitRevision = `${baseRevision}0000000000000000000000000000000000a`;
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-human");
    expect((await storedTask()).status).toBe("NEEDS_HUMAN");
    expect(await headRevision()).toBe(baseRevision);
    expect(existsSync(join(repoPath, change.path))).toBe(false);
  });

  it("does not guess when the integration branch and the recorded task commit have diverged", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    writeFileSync(join(repoPath, "divergent.txt"), "divergent work\n");
    await git.stageAll(repoPath);
    const divergedHead = await git.commitStaged(repoPath, "divergent work");
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-human");
    expect(outcome.detail).toContain("diverged");
    expect((await storedTask()).status).toBe("NEEDS_HUMAN");
    expect(await headRevision()).toBe(divergedHead);
    expect(await commitsSinceBase()).toBe(1);
  });

  it("surfaces a human-required outcome when integration evidence is missing", async () => {
    await createInterruptedWorktree();
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-human");
    expect((await storedTask()).status).toBe("NEEDS_HUMAN");
    expect(await headRevision()).toBe(baseRevision);
    const events = await store.listEvents({ taskId });
    expect(
      events.some(
        (event) =>
          event.type === ORCHESTRATION_EVENTS.recoveryReconciled &&
          (event.payload as { outcome?: string }).outcome === "requires-human",
      ),
    ).toBe(true);
  });

  it("escalates to a human when persisted attempt state is inconsistent", async () => {
    await seedTask("VERIFYING");
    await store.putAttempt({
      ...runningAttempt(),
      status: "FAILED",
      failure: { kind: "error", message: "stale" },
    });

    const outcome = await recovery.reconcileTask(taskId);

    expectOutcomeKind(outcome, "requires-human");
    expect((await storedTask()).status).toBe("NEEDS_HUMAN");
  });

  it("reconciles every unfinished task without scheduling or parallelism", async () => {
    const first = await createInterruptedWorktree();
    writeFileSync(join(first.worktreePath, change.path), change.content);
    await seedTask("IMPLEMENTING");
    await store.putAttempt(runningAttempt());

    const secondTaskId = "M002";
    const secondBranch = `task/M002/attempt-1`;
    const secondWorktreePath = join(worktreesDir, "M002", "attempt-1");
    await git.createBranch(repoPath, secondBranch);
    await git.createWorktree(repoPath, secondWorktreePath, secondBranch);
    writeFileSync(join(secondWorktreePath, change.path), change.content);
    await git.stageAll(secondWorktreePath);
    const secondRevision = await git.commitStaged(
      secondWorktreePath,
      `task ${secondTaskId}: Add a small utility function`,
    );
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", secondBranch]);
    await store.putTask(createTask({ id: secondTaskId, status: "FAILED" }));
    await store.putAttempt({
      ...runningAttempt(),
      id: "att_M002_1",
      taskId: secondTaskId,
      status: "FAILED",
      failure: { kind: "error", message: "integration persistence failed" },
      finishedAt: "2026-01-01T00:00:05.000Z",
    });
    await store.appendEvents([
      {
        type: ORCHESTRATION_EVENTS.commitCreated,
        taskId: secondTaskId,
        payload: {
          attemptId: "att_M002_1",
          revision: secondRevision,
          message: `task ${secondTaskId}: Add a small utility function`,
        },
        occurredAt: "2026-01-01T00:00:02.000Z",
      },
    ]);

    const outcomes = await recovery.reconcileUnfinished();

    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "requires-reconciliation",
      "completed",
    ]);
    expect((await storedTask()).status).toBe("BLOCKED");
    expect((await store.getTask(secondTaskId))?.status).toBe("DONE");
    expect(
      (await store.listEvents({ taskId: secondTaskId })).filter(
        (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
      ),
    ).toHaveLength(1);
  });

  it("converges a task persisted FAILED after a successful integration to DONE without integrating again", async () => {
    const { branch, worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", branch]);
    await seedTask("FAILED");
    await store.putAttempt(failedAfterIntegrationAttempt());
    await store.appendEvents([
      attemptStartedEvent(),
      implementationCompletedEvent([change.path]),
      commitCreatedEvent(commitRevision),
    ]);

    const commitsBefore = await commitsSinceBase();
    const headBefore = await headRevision();

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect(outcome.integration).toEqual({
      kind: "already-integrated",
      revision: commitRevision,
    });
    expect((await storedTask()).status).toBe("DONE");
    const attempt = await storedAttempt();
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.failure).toBeUndefined();
    expect(await headRevision()).toBe(headBefore);
    expect(await commitsSinceBase()).toBe(commitsBefore);

    const events = await store.listEvents({ taskId });
    expect(
      events.filter(
        (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
      ),
    ).toHaveLength(1);
    const repeated = await recovery.reconcileTask(taskId);
    expectNoOp(repeated);
    expect(
      (await store.listEvents({ taskId })).filter(
        (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
      ),
    ).toHaveLength(1);
  });

  it("does not append a second integration.completed event when one was persisted before the crash", async () => {
    const { branch, worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", branch]);
    await seedTask("FAILED");
    await store.putAttempt(failedAfterIntegrationAttempt());
    await store.appendEvents([
      commitCreatedEvent(commitRevision),
      {
        type: ORCHESTRATION_EVENTS.integrationCompleted,
        taskId,
        payload: { attemptId, revision: commitRevision, kind: "fast-forward" },
        occurredAt: "2026-01-01T00:00:04.000Z",
      },
    ]);

    const outcome = await recovery.reconcileTask(taskId);

    expectCompleted(outcome);
    expect((await storedTask()).status).toBe("DONE");
    expect(
      (await store.listEvents({ taskId })).filter(
        (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
      ),
    ).toHaveLength(1);
  });

  it("does not reopen a FAILED task whose recorded commit is not integrated", async () => {
    const { worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await seedTask("FAILED");
    await store.putAttempt(failedAfterIntegrationAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    const outcome = await recovery.reconcileTask(taskId);

    expectNoOp(outcome);
    expect((await storedTask()).status).toBe("FAILED");
    expect((await storedAttempt()).status).toBe("FAILED");
    expect(await headRevision()).toBe(baseRevision);
  });

  it("does not reopen FAILED tasks without integration evidence", async () => {
    await seedTask("FAILED");
    await store.putAttempt(failedAfterIntegrationAttempt());
    await store.putTask(createTask({ id: "M002", status: "CANCELLED" }));

    expectNoOp(await recovery.reconcileTask(taskId));
    expectNoOp(await recovery.reconcileTask("M002"));
    expect((await storedTask()).status).toBe("FAILED");
    expect((await store.getTask("M002"))?.status).toBe("CANCELLED");
  });

  it("persists reconciled state that survives a store reopen", async () => {    const { branch, worktreePath } = await createInterruptedWorktree();
    const commitRevision = await commitTaskChange(worktreePath);
    await runFixtureGit(runner, repoPath, ["merge", "--ff-only", branch]);
    await seedTask("INTEGRATING");
    await store.putAttempt(runningAttempt());
    await store.appendEvents([commitCreatedEvent(commitRevision)]);

    await recovery.reconcileTask(taskId);

    await store.close();
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    recovery = createCrashRecovery({
      store,
      git,
      verification: new FakeVerificationEngine((input) =>
        passedVerificationRun(input),
      ),
      verificationChecks: verificationChecks(),
      projectRoot: repoPath,
      worktreesDir,
    });

    expect((await storedTask()).status).toBe("DONE");
    expect((await storedAttempt()).status).toBe("SUCCEEDED");
    expectNoOp(await recovery.reconcileTask(taskId));
    expect(await commitsSinceBase()).toBe(1);
  });
});
