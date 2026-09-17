/**
 * Integration-base drift handling (M048a) against real Git repositories:
 * drift is classified against the CURRENT integration HEAD, a drifted task
 * branch is reconciled by a runner-controlled rebase inside its isolated
 * task worktree, conflicts stop integration with explicit evidence, and no
 * reconciliation ever duplicates integration or mutates attempt history.
 */

import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import { createIntegrationDriftService } from "../src/integration-drift.js";
import type {
  IntegrationDriftService,
  IntegrationReconciliationOutcome,
} from "../src/integration-drift.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  runFixtureGit,
} from "./fixtures.js";

const task: Task = createTask();
const attemptId = "att_M001_1";
const branch = `task/M001/attempt-1`;
const TASK_CHANGE =
  "export const add = (a: number, b: number): number => a + b;\n";
const INTEGRATION_CHANGE = "export const other = (): string => \"other\";\n";
const CONFLICTING_CHANGE =
  "export const add = (a: number, b: number): string => `conflicting`;\n";

let directory: string;
let repoPath: string;
let worktreesDir: string;
let worktreePath: string;
let runner: ProcessRunner;
let git: GitManager;
let store: RunnerStore;
let drift: IntegrationDriftService;
let baseRevision: string;
let taskRevision: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "agentic-runner-m048a-"));
  repoPath = join(directory, "repo");
  worktreesDir = join(directory, "worktrees");
  worktreePath = join(worktreesDir, "M001", "attempt-1");
  runner = createNodeProcessRunner();
  git = createGitManager({ runner });
  store = createSqliteRunnerStore({ path: join(directory, "state.db") });
  await store.initialize();
  await store.putProject(createProject());
  await store.putTask(task);
  drift = createIntegrationDriftService({ git, projectRoot: repoPath });
  baseRevision = await createFixtureRepository({
    runner,
    repositoryPath: repoPath,
    agentsMarkdown: AGENTS_MARKDOWN,
  });
  await run(["branch", branch]);
  await run(["worktree", "add", worktreePath, branch]);
  writeFileInWorktree("src/utils.ts", TASK_CHANGE);
  await runInWorktree(["add", "-A"]);
  await runInWorktree(["commit", "-m", `task M001: ${task.title}`]);
  taskRevision = await runInWorktree(["rev-parse", "HEAD"]);
  await store.putAttempt(attemptWithBase(baseRevision));
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function run(args: string[]): Promise<string> {
  return (await runFixtureGit(runner, repoPath, args)).trim();
}

async function runInWorktree(args: string[]): Promise<string> {
  return (await runFixtureGit(runner, worktreePath, args)).trim();
}

function writeFileInWorktree(relativePath: string, content: string): void {
  const target = join(worktreePath, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

async function writeIntegrationFile(
  relativePath: string,
  content: string,
): Promise<string> {
  const target = join(repoPath, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  await run(["add", "-A"]);
  await run(["commit", "-m", "integration change"]);
  return await run(["rev-parse", "HEAD"]);
}

/**
 * Creates a divergent orphan root commit from the integration tree and moves
 * the integration HEAD onto it, so the integration HEAD is no longer a
 * descendant of the attempt base.
 */
async function divergeIntegrationToOrphanRoot(): Promise<string> {
  const orphan = await createOrphanRevision();
  await run(["update-ref", "refs/heads/divergent", orphan]);
  await run(["checkout", "divergent"]);
  return orphan;
}

/**
 * Creates an orphan root commit object without moving the integration HEAD.
 */
async function createOrphanRevision(): Promise<string> {
  const tree = await run(["rev-parse", "HEAD^{tree}"]);
  return (
    await runFixtureGit(runner, repoPath, ["commit-tree", tree, "-m", "orphan root"])
  ).trim();
}

function attemptWithBase(base: string): Attempt {
  return {
    id: attemptId,
    taskId: task.id,
    number: 1,
    status: "SUCCEEDED",
    agent: "fake-agent",
    baseRevision: base,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
  };
}

function unexpectedOutcome(
  expected: string,
  outcome: IntegrationReconciliationOutcome,
): never {
  throw new Error(
    `expected reconciliation outcome "${expected}" but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
  );
}

describe("integration-base drift evaluation (M048a)", () => {
  it("classifies no drift while the integration HEAD still equals the base", async () => {
    const evaluation = await drift.evaluate({
      baseRevision,
      taskRevision,
    });

    expect(evaluation.status).toBe("CURRENT");
    expect(evaluation.integrationHead).toBe(baseRevision);
  });

  it("classifies drift when the integration HEAD advanced with an unrelated compatible change", async () => {
    const advancedHead = await writeIntegrationFile("src/other.ts", INTEGRATION_CHANGE);

    const evaluation = await drift.evaluate({
      baseRevision,
      taskRevision,
    });

    expect(evaluation.status).toBe("DRIFTED");
    expect(evaluation.integrationHead).toBe(advancedHead);
    expect(evaluation.baseRevision).toBe(baseRevision);
    expect(evaluation.taskRevision).toBe(taskRevision);
  });

  it("classifies an already-integrated task commit without re-integrating", async () => {
    await run(["merge", "--ff-only", branch]);
    const headAfterMerge = await run(["rev-parse", "HEAD"]);

    const evaluation = await drift.evaluate({
      baseRevision,
      taskRevision,
    });

    expect(evaluation.status).toBe("ALREADY_INTEGRATED");
    expect(await run(["rev-parse", "HEAD"])).toBe(headAfterMerge);
    expect(evaluation.integrationHead).toBe(headAfterMerge);
  });

  it("classifies an integration HEAD that diverged from the task base as unsafe", async () => {
    await divergeIntegrationToOrphanRoot();

    const evaluation = await drift.evaluate({
      baseRevision,
      taskRevision,
    });

    expect(evaluation.status).toBe("UNSAFE");
  });

  it("classifies a task commit that does not descend from its recorded base as unsafe", async () => {
    const orphanRoot = await createOrphanRevision();

    const evaluation = await drift.evaluate({
      baseRevision,
      taskRevision: orphanRoot,
    });

    expect(evaluation.status).toBe("UNSAFE");
  });

  it("uses the current integration HEAD on every evaluation, not an enqueue-time HEAD", async () => {
    expect(
      (await drift.evaluate({ baseRevision, taskRevision })).status,
    ).toBe("CURRENT");

    const advancedHead = await writeIntegrationFile("src/other.ts", INTEGRATION_CHANGE);
    const drifted = await drift.evaluate({ baseRevision, taskRevision });
    expect(drifted.status).toBe("DRIFTED");
    expect(drifted.integrationHead).toBe(advancedHead);
    expect(drifted.integrationHead).not.toBe(baseRevision);

    const furtherHead = await writeIntegrationFile("src/another.ts", INTEGRATION_CHANGE);
    const further = await drift.evaluate({ baseRevision, taskRevision });
    expect(further.integrationHead).toBe(furtherHead);
    expect(further.integrationHead).not.toBe(advancedHead);
  });
});

describe("integration-base drift reconciliation (M048a)", () => {
  it("reconciles a drifted branch onto the current integration HEAD without integrating", async () => {
    const advancedHead = await writeIntegrationFile("src/other.ts", INTEGRATION_CHANGE);

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    if (outcome.kind !== "reconciled") unexpectedOutcome("reconciled", outcome);
    expect(outcome.verificationRequired).toBe(true);
    expect(outcome.previousTaskRevision).toBe(taskRevision);
    expect(outcome.taskRevision).not.toBe(taskRevision);
    expect(outcome.integrationHead).toBe(advancedHead);

    expect(await run(["rev-parse", "HEAD"])).toBe(advancedHead);
    expect(readFileSync(join(worktreePath, "src/utils.ts"), "utf8")).toBe(TASK_CHANGE);
    expect(readFileSync(join(worktreePath, "src/other.ts"), "utf8")).toBe(
      INTEGRATION_CHANGE,
    );
  });

  it("keeps the original attempt base inspectable in attempt history", async () => {
    await writeIntegrationFile("src/other.ts", INTEGRATION_CHANGE);

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    if (outcome.kind !== "reconciled") unexpectedOutcome("reconciled", outcome);
    const attempt = await store.getAttempt(attemptId);
    expect(attempt?.baseRevision).toBe(baseRevision);
  });

  it("reports a conflict with explicit evidence and restores the original task commit", async () => {
    const advancedHead = await writeIntegrationFile("src/utils.ts", CONFLICTING_CHANGE);

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    if (outcome.kind !== "conflict") unexpectedOutcome("conflict", outcome);
    expect(outcome.conflictedPaths).toEqual(["src/utils.ts"]);
    expect(outcome.integrationHead).toBe(advancedHead);

    expect(await run(["rev-parse", "HEAD"])).toBe(advancedHead);
    expect(await runInWorktree(["rev-parse", "HEAD"])).toBe(taskRevision);
    expect(readFileSync(join(worktreePath, "src/utils.ts"), "utf8")).toBe(TASK_CHANGE);
  });

  it("stops integration while a conflict is unresolved", async () => {
    await writeIntegrationFile("src/utils.ts", CONFLICTING_CHANGE);

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    expect(outcome.kind).toBe("conflict");
    const integrationHead = await run(["rev-parse", "HEAD"]);
    expect(await git.isAncestor(repoPath, taskRevision, integrationHead)).toBe(false);
    expect(await runInWorktree(["rev-parse", "HEAD"])).toBe(taskRevision);
  });

  it("never integrates a second time when the task commit is already integrated", async () => {
    await run(["merge", "--ff-only", branch]);
    const headAfterMerge = await run(["rev-parse", "HEAD"]);

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    if (outcome.kind !== "already-integrated") unexpectedOutcome("already-integrated", outcome);
    expect(await run(["rev-parse", "HEAD"])).toBe(headAfterMerge);
  });

  it("does not reconcile when the task worktree is missing", async () => {
    await writeIntegrationFile("src/other.ts", INTEGRATION_CHANGE);

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath: join(worktreesDir, "M001", "missing"),
    });

    if (outcome.kind !== "failed") unexpectedOutcome("failed", outcome);
    expect(outcome.detail).toContain("does not exist");
    expect(await runInWorktree(["rev-parse", "HEAD"])).toBe(taskRevision);
  });

  it("leaves integration HEAD untouched when a rebase fails without conflicts", async () => {
    const advancedHead = await writeIntegrationFile("src/other.ts", INTEGRATION_CHANGE);
    writeFileInWorktree("src/utils.ts", "uncommitted local edit\n");

    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    if (outcome.kind !== "failed") unexpectedOutcome("failed", outcome);
    expect(await run(["rev-parse", "HEAD"])).toBe(advancedHead);
    expect(await runInWorktree(["rev-parse", "HEAD"])).toBe(taskRevision);
  });

  it("does not integrate when reconciliation is unnecessary (current base)", async () => {
    const outcome = await drift.reconcile({
      baseRevision,
      taskRevision,
      worktreePath,
    });

    if (outcome.kind !== "current") unexpectedOutcome("current", outcome);
    expect("verificationRequired" in outcome).toBe(false);
    expect(outcome.integrationHead).toBe(baseRevision);
    expect(await runInWorktree(["rev-parse", "HEAD"])).toBe(taskRevision);
  });
});
