import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import {
  CODE_REVIEW_STAGE_INSTRUCTION,
  codeReviewStageRunId,
  executeCodeReviewStage,
  planStageRunId,
  type CodeReviewStageOptions,
  type CodeReviewStageOutcome,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  agentFails,
  agentIsCancelled,
  agentTimesOut,
  createFixtureRepository,
  createProject,
  createTask,
  FakeAgentRuntime,
  runFixtureGit,
} from "./fixtures.js";
import type { AgentBehavior } from "./fixtures.js";

const taskId = "M001";
const attemptId = `att_${taskId}_1`;
const branch = `task/${taskId}/attempt-1`;
const IMPLEMENTATION_CONTENT =
  "export const add = (a: number, b: number): number => a + b;\n";
const UNTRACKED_REPORT_PATH = "src/generated-report.txt";
const UNTRACKED_REPORT_CONTENT = "generated during implementation\n";
const PLAN_TEXT = [
  "# Implementation plan",
  "1. Add `src/utils.ts` with a validated `add` function.",
  "2. Cover the function with unit tests.",
].join("\n");

const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

let directory: string;
let repoPath: string;
let worktreesDir: string;
let worktreePath: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let baseRevision: string;
let agent: FakeAgentRuntime;

function agentReturnsReview(review: unknown): AgentBehavior {
  return () => ({
    kind: "success",
    output: { stdout: JSON.stringify(review), stderr: "" },
    exitCode: 0,
    durationMs: 5,
  });
}

function agentReturnsText(text: string): AgentBehavior {
  return () => ({
    kind: "success",
    output: { stdout: text, stderr: "" },
    exitCode: 0,
    durationMs: 5,
  });
}

function agentProducesEmptyOutput(): AgentBehavior {
  return () => ({
    kind: "success",
    output: { stdout: "", stderr: "cannot review today" },
    exitCode: 0,
    durationMs: 5,
  });
}

function writeWorktreeFile(
  targetWorktreePath: string,
  relativePath: string,
  content: string,
): void {
  const target = join(targetWorktreePath, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function agentAppliesChange(change: {
  readonly path: string;
  readonly content: string;
}): AgentBehavior {
  return (invocation) => {
    writeWorktreeFile(invocation.worktreePath, change.path, change.content);
    return {
      kind: "success",
      output: { stdout: JSON.stringify({ decision: "APPROVED" }), stderr: "" },
      exitCode: 0,
      durationMs: 5,
    };
  };
}

function agentCommitsInWorktree(change: {
  readonly path: string;
  readonly content: string;
}): AgentBehavior {
  return async (invocation) => {
    writeWorktreeFile(invocation.worktreePath, change.path, change.content);
    await runFixtureGit(runner, invocation.worktreePath, ["add", change.path]);
    await runFixtureGit(runner, invocation.worktreePath, [
      "commit",
      "-m",
      "review agent should not commit",
    ]);
    return {
      kind: "success",
      output: { stdout: JSON.stringify({ decision: "APPROVED" }), stderr: "" },
      exitCode: 0,
      durationMs: 5,
    };
  };
}

/**
 * Seeds the attempt's implementation directly in the given task worktree and
 * commits it, so the review evaluates a real committed task delta.
 */
async function commitImplementationIn(
  targetWorktreePath: string,
  options: { untrackedReport?: boolean } = {},
): Promise<void> {
  writeWorktreeFile(targetWorktreePath, "src/utils.ts", IMPLEMENTATION_CONTENT);
  await runFixtureGit(runner, targetWorktreePath, ["add", "src/utils.ts"]);
  await runFixtureGit(runner, targetWorktreePath, [
    "commit",
    "-m",
    "attempt: implement task M001",
  ]);
  if (options.untrackedReport === true) {
    writeWorktreeFile(
      targetWorktreePath,
      UNTRACKED_REPORT_PATH,
      UNTRACKED_REPORT_CONTENT,
    );
  }
}

async function seedCommittedImplementation(options: {
  untrackedReport?: boolean;
} = {}): Promise<void> {
  await commitImplementationIn(worktreePath, options);
}

/**
 * Seeds the attempt's implementation as staged-but-uncommitted changes, so
 * the review evaluates a real task delta on a legitimately dirty worktree.
 */
async function seedStagedImplementation(): Promise<void> {
  writeWorktreeFile(worktreePath, "src/utils.ts", IMPLEMENTATION_CONTENT);
  await runFixtureGit(runner, worktreePath, ["add", "src/utils.ts"]);
}

async function seedPlanStageRun(plan: string = PLAN_TEXT): Promise<void> {
  await store.putStageRun({
    id: planStageRunId(attemptId),
    attemptId,
    stage: "PLAN",
    status: "SUCCEEDED",
    startedAt: FIXED_CLOCK,
    finishedAt: FIXED_CLOCK,
    output: { plan },
  });
}

function expectCompleted(
  outcome: CodeReviewStageOutcome,
): asserts outcome is Extract<CodeReviewStageOutcome, { kind: "completed" }> {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed CODE_REVIEW outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailed(
  outcome: CodeReviewStageOutcome,
): asserts outcome is Extract<CodeReviewStageOutcome, { kind: "failed" }> {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed CODE_REVIEW outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

async function storedTask(id: string = taskId): Promise<Task> {
  const task = await store.getTask(id);
  if (task === null) {
    throw new Error(`task "${id}" not found in store`);
  }
  return task;
}

async function storedAttempt(id: string = attemptId): Promise<Attempt> {
  const attempt = await store.getAttempt(id);
  if (attempt === null) {
    throw new Error(`attempt "${id}" not found in store`);
  }
  return attempt;
}

async function createSecondAttempt(): Promise<{
  readonly attemptId: string;
  readonly worktreePath: string;
}> {
  const attemptId2 = "att_M001_2";
  const worktreePath2 = join(worktreesDir, taskId, "attempt-2");
  await store.putAttempt({
    ...(await storedAttempt()),
    id: attemptId2,
    number: 2,
  });
  await git.createBranch(repoPath, "task/M001/attempt-2");
  await git.createWorktree(repoPath, worktreePath2, "task/M001/attempt-2");
  return { attemptId: attemptId2, worktreePath: worktreePath2 };
}

describe("executeCodeReviewStage (M055a)", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m055a-"));
    repoPath = join(directory, "project repo");
    worktreesDir = join(directory, "worktrees");
    worktreePath = join(worktreesDir, taskId, "attempt-1");
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
    await store.putTask(createTask({ id: taskId, status: "READY" }));
    await store.putAttempt({
      id: attemptId,
      taskId,
      number: 1,
      status: "RUNNING",
      agent: "fake-agent",
      baseRevision,
      startedAt: FIXED_CLOCK,
    });
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
    agent = new FakeAgentRuntime();
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function codeReviewOptions(
    overrides: Partial<CodeReviewStageOptions> = {},
  ): Promise<CodeReviewStageOptions> {
    return {
      store,
      git,
      agent,
      task: await storedTask(),
      attemptId,
      worktreePath,
      baseRevision,
      timeoutMs: 5_000,
      now: () => FIXED_CLOCK,
      ...overrides,
    };
  }

  it("completes an APPROVED review of the implementation delta", async () => {
    let sawRunningStageRun = false;
    agent = new FakeAgentRuntime(async () => {
      const stageRuns = await store.listStageRuns(attemptId);
      sawRunningStageRun = stageRuns.some(
        (run) =>
          run.id === codeReviewStageRunId(attemptId) && run.status === "RUNNING",
      );
      return {
        kind: "success",
        output: { stdout: JSON.stringify({ decision: "APPROVED" }), stderr: "" },
        exitCode: 0,
        durationMs: 5,
      };
    });
    await seedCommittedImplementation({ untrackedReport: true });

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    expect(sawRunningStageRun).toBe(true);
    expect(outcome.decision).toBe("APPROVED");
    expect(outcome.feedback).toBeUndefined();
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.failure).toBeUndefined();
    expect(outcome.stageRun.output?.codeReview).toEqual({ decision: "APPROVED" });
    expect(outcome.stageRun.output?.stdout).toBe(
      JSON.stringify({ decision: "APPROVED" }),
    );
    expect(agent.invocations).toHaveLength(1);
  });

  it("completes a CHANGES_REQUIRED review with persisted actionable feedback", async () => {
    const feedback =
      "The `add` function performs no input validation and its tests are missing; add validation rules and cover rejected inputs.";
    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED", feedback }),
    );
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    expect(outcome.decision).toBe("CHANGES_REQUIRED");
    expect(outcome.feedback).toBe(feedback);
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.output?.codeReview).toEqual({
      decision: "CHANGES_REQUIRED",
      feedback,
    });
    expect((await storedTask()).status).toBe("READY");
  });

  it("persists durable reviewer output and evidence across a store reopen", async () => {
    const feedback = "The new utility duplicates the existing `sum` helper.";
    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED", feedback }),
    );
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());
    expectCompleted(outcome);

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      const durableRuns = await reopened.listStageRuns(attemptId);
      const reviewRun = durableRuns.find((run) => run.stage === "CODE_REVIEW");
      expect(reviewRun?.status).toBe("SUCCEEDED");
      expect(reviewRun?.output?.codeReview).toEqual({
        decision: "CHANGES_REQUIRED",
        feedback,
      });
      expect(reviewRun?.output?.stdout).toBe(
        JSON.stringify({ decision: "CHANGES_REQUIRED", feedback }),
      );
    } finally {
      await reopened.close();
    }
  });

  it("uses the deterministic CODE_REVIEW StageRun identity on the attempt", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    expect(outcome.stageRun.id).toBe(codeReviewStageRunId(attemptId));
    expect(outcome.stageRun.id).toBe(`stage_${attemptId}_CODE_REVIEW`);
    expect(outcome.stageRun.id).not.toBe(planStageRunId(attemptId));
    expect(outcome.stageRun.attemptId).toBe(attemptId);
    expect(outcome.stageRun.stage).toBe("CODE_REVIEW");
    expect(outcome.stageRun.startedAt).toBe(FIXED_CLOCK);
    expect(outcome.stageRun.finishedAt).toBe(FIXED_CLOCK);
    const stageRuns = await store.listStageRuns(attemptId);
    expect(stageRuns.map((run) => run.id)).toEqual([
      codeReviewStageRunId(attemptId),
    ]);
  });

  it("hands the reviewer the actual implementation diff evidence, not an agent-written summary", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation({ untrackedReport: true });

    await executeCodeReviewStage(await codeReviewOptions());

    const invocation = agent.invocations[0];
    expect(invocation).toBeDefined();
    const evidenceDocument = invocation?.contextPack.documents.find(
      (document) => document.path === "IMPLEMENTATION_DIFF",
    );
    expect(evidenceDocument?.content).toContain("diff --git");
    expect(evidenceDocument?.content).toContain("src/utils.ts");
    expect(evidenceDocument?.content).toContain(
      "+export const add = (a: number, b: number): number => a + b;",
    );
    expect(evidenceDocument?.content).toContain(
      `NEW UNTRACKED FILE: ${UNTRACKED_REPORT_PATH}`,
    );
    expect(evidenceDocument?.content).toContain(UNTRACKED_REPORT_CONTENT);
    expect(invocation?.instruction).toBe(CODE_REVIEW_STAGE_INSTRUCTION);
  });

  it("includes the persisted PLAN output in the reviewer context when available", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();
    await seedPlanStageRun();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    const invocation = agent.invocations[0];
    const evidenceDocument = invocation?.contextPack.documents.find(
      (document) => document.path === "IMPLEMENTATION_DIFF",
    );
    const planDocument = invocation?.contextPack.documents.find(
      (document) => document.path === "PLAN",
    );
    expect(evidenceDocument?.content).toContain("src/utils.ts");
    expect(planDocument?.content).toBe(PLAN_TEXT);
  });

  it("still reviews the implementation when no PLAN output is persisted", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    expect(outcome.decision).toBe("APPROVED");
    const invocation = agent.invocations[0];
    expect(
      invocation?.contextPack.documents.some(
        (document) => document.path === "PLAN",
      ),
    ).toBe(false);
    expect(
      invocation?.contextPack.documents.some(
        (document) => document.path === "IMPLEMENTATION_DIFF",
      ),
    ).toBe(true);
  });

  it("reviews staged-but-uncommitted implementation evidence without false mutation failures", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedStagedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    const evidenceDocument = agent.invocations[0]?.contextPack.documents.find(
      (document) => document.path === "IMPLEMENTATION_DIFF",
    );
    expect(evidenceDocument?.content).toContain("src/utils.ts");
    expect(evidenceDocument?.content).toContain(
      "+export const add = (a: number, b: number): number => a + b;",
    );
    expect(outcome.stageRun.output?.codeReview).toEqual({
      decision: "APPROVED",
    });
  });

  it("fails the stage when the attempt has no implementation changes to review", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("no implementation changes to review");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(agent.invocations).toHaveLength(0);
  });

  it("gives an explicit review-only instruction that never asks the reviewer to fix code", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();

    await executeCodeReviewStage(await codeReviewOptions());

    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain("review only");
    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain("Do NOT fix issues");
    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain(
      "Do NOT create, modify, or delete any files",
    );
    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain(
      "Do NOT run builds, tests, or Git commands",
    );
    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain(
      "Do NOT create commits or perform Git integration",
    );
    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain('"decision":"APPROVED"');
    expect(CODE_REVIEW_STAGE_INSTRUCTION).toContain('"CHANGES_REQUIRED"');
    expect(CODE_REVIEW_STAGE_INSTRUCTION).not.toMatch(
      /fix the|apply the changes|implement the|resolve the concerns/i,
    );
    const invocation = agent.invocations[0];
    expect(invocation?.instruction).toBe(CODE_REVIEW_STAGE_INSTRUCTION);
  });

  it("does not transition task or attempt state, emit events, or decide the next stage", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();
    const headBefore = await git.resolveHeadRevision(worktreePath);

    const beforeEvents = await store.listEvents();
    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectCompleted(outcome);
    expect((await storedTask()).status).toBe("READY");
    expect(await store.getTaskStatus(taskId)).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
    expect(await store.listEvents()).toEqual(beforeEvents);
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.stage).toBe("CODE_REVIEW");
    expect(await git.resolveHeadRevision(worktreePath)).toBe(headBefore);
  });

  it("keeps the authoritative task status unchanged when changes are required or the stage fails", async () => {
    agent = new FakeAgentRuntime(
      agentReturnsReview({
        decision: "CHANGES_REQUIRED",
        feedback: "handle the rejection path",
      }),
    );
    await seedCommittedImplementation();
    await executeCodeReviewStage(await codeReviewOptions());
    expect((await storedTask()).status).toBe("READY");
    expect(await store.getTaskStatus(taskId)).toBe("READY");

    agent = new FakeAgentRuntime(agentFails("agent crashed with code 3"));
    await executeCodeReviewStage(await codeReviewOptions());
    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
  });

  it("fails the stage on malformed reviewer output that is not JSON", async () => {
    agent = new FakeAgentRuntime(
      agentReturnsText("The implementation looks good overall."),
    );
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("malformed CODE_REVIEW output");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.stdout).toBe(
      "The implementation looks good overall.",
    );
    expect(outcome.stageRun.output?.codeReview).toBeUndefined();
  });

  it("fails the stage on a review object with a missing or unknown decision", async () => {
    await seedCommittedImplementation();

    agent = new FakeAgentRuntime(
      agentReturnsReview({ feedback: "missing decision" }),
    );
    const missingDecision = await executeCodeReviewStage(
      await codeReviewOptions(),
    );
    expectFailed(missingDecision);
    expect(missingDecision.reason).toContain("missing or invalid review decision");

    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "MAYBE", feedback: "not a decision" }),
    );
    const unknownDecision = await executeCodeReviewStage(
      await codeReviewOptions(),
    );
    expectFailed(unknownDecision);
    expect(unknownDecision.reason).toContain('unknown review decision "MAYBE"');
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the stage when CHANGES_REQUIRED carries no meaningful feedback", async () => {
    await seedCommittedImplementation();

    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED" }),
    );
    const noFeedback = await executeCodeReviewStage(await codeReviewOptions());
    expectFailed(noFeedback);
    expect(noFeedback.reason).toContain(
      "CHANGES_REQUIRED requires actionable feedback",
    );

    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED", feedback: "   " }),
    );
    const blankFeedback = await executeCodeReviewStage(
      await codeReviewOptions(),
    );
    expectFailed(blankFeedback);
    expect(blankFeedback.reason).toContain(
      "CHANGES_REQUIRED requires actionable feedback",
    );
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the stage on malformed feedback that is not a string", async () => {
    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "APPROVED", feedback: 42 }),
    );
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      "review feedback must be a non-empty string",
    );
  });

  it("fails the stage when the reviewer produces no review output", async () => {
    agent = new FakeAgentRuntime(agentProducesEmptyOutput());
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toBe("the agent produced no review output");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output).toEqual({
      stdout: "",
      stderr: "cannot review today",
    });
  });

  it("marks the stage TIMED_OUT when the agent invocation times out", async () => {
    agent = new FakeAgentRuntime(agentTimesOut());
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("timed out");
    expect(outcome.stageRun.status).toBe("TIMED_OUT");
    expect(outcome.stageRun.failure).toEqual({
      kind: "timeout",
      message: expect.stringContaining("timed out"),
    });
    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
  });

  it("marks the stage CANCELLED when the agent invocation is cancelled", async () => {
    agent = new FakeAgentRuntime(agentIsCancelled());
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure?.kind).toBe("cancelled");
    expect((await storedTask()).status).toBe("READY");
  });

  it("cancels the stage before invoking the agent when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(
      await codeReviewOptions({ signal: controller.signal }),
    );

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure?.kind).toBe("cancelled");
    expect(agent.invocations).toHaveLength(0);
  });

  it("fails the stage without task completion when the agent process fails", async () => {
    agent = new FakeAgentRuntime(agentFails("agent crashed with code 3"));
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("agent crashed with code 3");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.failure).toEqual({
      kind: "error",
      message: "agent failed: agent crashed with code 3",
    });
    expect(outcome.stageRun.output).toEqual({
      stdout: "partial output",
      stderr: "agent crashed with code 3",
    });
    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
  });

  it("fails the stage when the reviewer modifies worktree source files during review", async () => {
    const change = {
      path: "review-fix.ts",
      content: "export const fixed = true;\n",
    };
    agent = new FakeAgentRuntime(agentAppliesChange(change));
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("modified the task worktree");
    expect(outcome.reason).toContain(change.path);
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.codeReview).toBeUndefined();
    expect((await storedTask()).status).toBe("READY");
    expect(existsSync(join(worktreePath, change.path))).toBe(true);
  });

  it("fails the stage when the reviewer rewrites the content of a pre-existing untracked file", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: UNTRACKED_REPORT_PATH,
        content: "tampered during review\n",
      }),
    );
    await seedCommittedImplementation({ untrackedReport: true });

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("modified the task worktree");
    expect(outcome.reason).toContain("untracked file content changed");
    expect(outcome.reason).toContain(UNTRACKED_REPORT_PATH);
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.codeReview).toBeUndefined();
    expect((await storedTask()).status).toBe("READY");
    expect(readFileSync(join(worktreePath, UNTRACKED_REPORT_PATH), "utf8")).toBe(
      "tampered during review\n",
    );
  });

  it("fails the stage when the reviewer rewrites the content of a tracked implementation file", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const broken = true;\n",
      }),
    );
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("modified the task worktree");
    expect(outcome.reason).toContain("src/utils.ts");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.codeReview).toBeUndefined();
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the stage when the reviewer commits inside the worktree during review", async () => {
    agent = new FakeAgentRuntime(
      agentCommitsInWorktree({
        path: "src/sneaky.ts",
        content: "export const sneaky = true;\n",
      }),
    );
    await seedCommittedImplementation();

    const outcome = await executeCodeReviewStage(await codeReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("no longer matches pre-review revision");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.codeReview).toBeUndefined();
    expect((await storedTask()).status).toBe("READY");
  });

  it("behaves identically regardless of the agent provider identity", async () => {
    const second = await createSecondAttempt();
    await seedCommittedImplementation();
    await commitImplementationIn(second.worktreePath);

    const outcomes: CodeReviewStageOutcome[] = [];
    for (const [index, providerId] of ["codex-like", "opencode-like"].entries()) {
      const providerAgent = new FakeAgentRuntime(
        agentReturnsReview({ decision: "APPROVED" }),
        { id: providerId },
      );
      agent = providerAgent;
      const isFirst = index === 0;
      outcomes.push(
        await executeCodeReviewStage(
          await codeReviewOptions(
            isFirst
              ? {}
              : {
                  attemptId: second.attemptId,
                  worktreePath: second.worktreePath,
                },
          ),
        ),
      );
      expect(providerAgent.invocations[0]?.agent.id).toBe(providerId);
      expect(providerAgent.invocations[0]?.instruction).toBe(
        CODE_REVIEW_STAGE_INSTRUCTION,
      );
    }

    const [first, secondOutcome] = outcomes;
    if (first === undefined || secondOutcome === undefined) {
      throw new Error("expected two CODE_REVIEW stage outcomes");
    }
    expectCompleted(first);
    expectCompleted(secondOutcome);
    expect(first.decision).toBe(secondOutcome.decision);
    expect(first.stageRun.status).toBe(secondOutcome.stageRun.status);
    expect(first.stageRun.stage).toBe(secondOutcome.stageRun.stage);
    expect(first.stageRun.id).toBe(codeReviewStageRunId(attemptId));
    expect(secondOutcome.stageRun.id).toBe(codeReviewStageRunId(second.attemptId));
    const reviewRuns = (await store.listStageRuns(attemptId)).concat(
      await store.listStageRuns(second.attemptId),
    );
    const codeReviewRuns = reviewRuns.filter((run) => run.stage === "CODE_REVIEW");
    expect(codeReviewRuns).toHaveLength(2);
    for (const run of codeReviewRuns) {
      expect(run.output?.codeReview).toEqual({ decision: "APPROVED" });
    }
  });

  it("rejects invalid stage options before creating a stage run", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));
    await seedCommittedImplementation();

    await expect(
      executeCodeReviewStage(await codeReviewOptions({ timeoutMs: 0 })),
    ).rejects.toThrow("timeoutMs must be a positive finite number");
    await expect(
      executeCodeReviewStage(await codeReviewOptions({ attemptId: "  " })),
    ).rejects.toThrow("attemptId must be a non-empty string");
    expect(agent.invocations).toHaveLength(0);
    expect(await store.listStageRuns(attemptId)).toHaveLength(0);
  });
});
