import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  PLAN_REVIEW_STAGE_INSTRUCTION,
  executePlanReviewStage,
  planReviewStageRunId,
  planStageRunId,
  type PlanReviewStageOptions,
  type PlanReviewStageOutcome,
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
  worktreePath: string,
  relativePath: string,
  content: string,
): void {
  const target = join(worktreePath, relativePath);
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

async function seedAttempt(): Promise<Attempt> {
  const attempt: Attempt = {
    id: attemptId,
    taskId,
    number: 1,
    status: "RUNNING",
    agent: "fake-agent",
    baseRevision,
    startedAt: FIXED_CLOCK,
  };
  await store.putAttempt(attempt);
  return attempt;
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
  outcome: PlanReviewStageOutcome,
): asserts outcome is Extract<PlanReviewStageOutcome, { kind: "completed" }> {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed PLAN_REVIEW outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailed(
  outcome: PlanReviewStageOutcome,
): asserts outcome is Extract<PlanReviewStageOutcome, { kind: "failed" }> {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed PLAN_REVIEW outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
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

async function expectHeadAt(revision: string): Promise<void> {
  expect(await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD"])).toBe(
    `${revision}\n`,
  );
}

describe("executePlanReviewStage (M053a)", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m053a-"));
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
    await seedAttempt();
    await seedPlanStageRun();
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
    agent = new FakeAgentRuntime();
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function planReviewOptions(
    overrides: Partial<PlanReviewStageOptions> = {},
  ): Promise<PlanReviewStageOptions> {
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

  it("completes an APPROVED review of the persisted PLAN output", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectCompleted(outcome);
    expect(outcome.decision).toBe("APPROVED");
    expect(outcome.feedback).toBeUndefined();
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.failure).toBeUndefined();
    expect(outcome.stageRun.output?.planReview).toEqual({ decision: "APPROVED" });
    expect(agent.invocations).toHaveLength(1);
  });

  it("completes a CHANGES_REQUIRED review with persisted actionable feedback", async () => {
    const feedback =
      "Step 1 must define the validation rules for `add` and respect the allowed src/** scope.";
    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED", feedback }),
    );

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectCompleted(outcome);
    expect(outcome.decision).toBe("CHANGES_REQUIRED");
    expect(outcome.feedback).toBe(feedback);
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.output?.planReview).toEqual({
      decision: "CHANGES_REQUIRED",
      feedback,
    });
  });

  it("persists durable reviewer output and evidence across a store reopen", async () => {
    const feedback = "The plan lacks test coverage for rejected inputs.";
    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED", feedback }),
    );

    const outcome = await executePlanReviewStage(await planReviewOptions());
    expectCompleted(outcome);

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      const durableRuns = await reopened.listStageRuns(attemptId);
      const reviewRun = durableRuns.find((run) => run.stage === "PLAN_REVIEW");
      expect(reviewRun?.status).toBe("SUCCEEDED");
      expect(reviewRun?.output?.planReview).toEqual({
        decision: "CHANGES_REQUIRED",
        feedback,
      });
    } finally {
      await reopened.close();
    }
  });

  it("uses the deterministic PLAN_REVIEW StageRun identity on the attempt", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectCompleted(outcome);
    expect(outcome.stageRun.id).toBe(planReviewStageRunId(attemptId));
    expect(outcome.stageRun.id).toBe(`stage_${attemptId}_PLAN_REVIEW`);
    expect(outcome.stageRun.id).not.toBe(planStageRunId(attemptId));
    expect(outcome.stageRun.attemptId).toBe(attemptId);
    expect(outcome.stageRun.stage).toBe("PLAN_REVIEW");
    expect(outcome.stageRun.startedAt).toBe(FIXED_CLOCK);
    expect(outcome.stageRun.finishedAt).toBe(FIXED_CLOCK);
    const stageRuns = await store.listStageRuns(attemptId);
    expect(stageRuns.map((run) => run.id)).toEqual([
      planStageRunId(attemptId),
      planReviewStageRunId(attemptId),
    ]);
  });

  it("hands the reviewer the persisted PLAN output and never asks it to create a plan", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    await executePlanReviewStage(await planReviewOptions());

    const invocation = agent.invocations[0];
    expect(invocation).toBeDefined();
    const planDocument = invocation?.contextPack.documents.find(
      (document) => document.path === "PLAN",
    );
    expect(planDocument?.content).toBe(PLAN_TEXT);
    expect(invocation?.instruction).toBe(PLAN_REVIEW_STAGE_INSTRUCTION);
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain("review only");
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain(
      "implementation plan provided in the context pack",
    );
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).not.toMatch(
      /Produce a .* plan|create a plan|write a plan/i,
    );
  });

  it("gives an explicit review-only instruction that forbids implementation and file changes", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    await executePlanReviewStage(await planReviewOptions());

    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain("Do NOT implement source code");
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain(
      "Do NOT create, modify, or delete any files",
    );
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain(
      "Do NOT run builds, tests, or Git commands",
    );
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain('"decision":"APPROVED"');
    expect(PLAN_REVIEW_STAGE_INSTRUCTION).toContain('"CHANGES_REQUIRED"');
    const invocation = agent.invocations[0];
    expect(invocation?.instruction).toBe(PLAN_REVIEW_STAGE_INSTRUCTION);
  });

  it("does not transition task or attempt state, emit events, or write into the worktree", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    const beforeEvents = await store.listEvents();
    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectCompleted(outcome);
    expect((await storedTask()).status).toBe("READY");
    expect(await store.getTaskStatus(taskId)).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
    expect(await store.listEvents()).toEqual(beforeEvents);
    expect(existsSync(join(worktreePath, "src"))).toBe(false);
    await expectHeadAt(baseRevision);
  });

  it("keeps the authoritative task status unchanged for a CHANGES_REQUIRED review", async () => {
    agent = new FakeAgentRuntime(
      agentReturnsReview({
        decision: "CHANGES_REQUIRED",
        feedback: "revise the plan",
      }),
    );

    await executePlanReviewStage(await planReviewOptions());

    expect((await storedTask()).status).toBe("READY");
    expect(await store.getTaskStatus(taskId)).toBe("READY");
  });

  it("fails the stage on malformed reviewer output that is not JSON", async () => {
    agent = new FakeAgentRuntime(
      agentReturnsText("The plan looks good, no changes needed."),
    );

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("malformed PLAN_REVIEW output");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.stdout).toBe(
      "The plan looks good, no changes needed.",
    );
  });

  it("fails the stage on a review object with a missing or unknown decision", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ feedback: "missing decision" }));
    const missingDecision = await executePlanReviewStage(await planReviewOptions());
    expectFailed(missingDecision);
    expect(missingDecision.reason).toContain(
      "missing or invalid review decision",
    );

    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "MAYBE", feedback: "not a decision" }),
    );
    const unknownDecision = await executePlanReviewStage(await planReviewOptions());
    expectFailed(unknownDecision);
    expect(unknownDecision.reason).toContain('unknown review decision "MAYBE"');
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the stage when CHANGES_REQUIRED carries no meaningful feedback", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "CHANGES_REQUIRED" }));
    const noFeedback = await executePlanReviewStage(await planReviewOptions());
    expectFailed(noFeedback);
    expect(noFeedback.reason).toContain(
      "CHANGES_REQUIRED requires actionable feedback",
    );

    agent = new FakeAgentRuntime(
      agentReturnsReview({ decision: "CHANGES_REQUIRED", feedback: "   " }),
    );
    const blankFeedback = await executePlanReviewStage(await planReviewOptions());
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

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      "review feedback must be a non-empty string",
    );
  });

  it("fails the stage when the reviewer produces no review output", async () => {
    agent = new FakeAgentRuntime(agentProducesEmptyOutput());

    const outcome = await executePlanReviewStage(await planReviewOptions());

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

    const outcome = await executePlanReviewStage(await planReviewOptions());

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

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure?.kind).toBe("cancelled");
    expect((await storedTask()).status).toBe("READY");
  });

  it("cancels the stage before invoking the agent when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    const outcome = await executePlanReviewStage(
      await planReviewOptions({ signal: controller.signal }),
    );

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure?.kind).toBe("cancelled");
    expect(agent.invocations).toHaveLength(0);
  });

  it("fails the stage without task completion when the agent process fails", async () => {
    agent = new FakeAgentRuntime(agentFails("agent crashed with code 3"));

    const outcome = await executePlanReviewStage(await planReviewOptions());

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

  it("fails the stage when the reviewer modifies worktree source files", async () => {
    const change = {
      path: "review-mutation.ts",
      content: "export const add = (a: number, b: number): number => a + b;\n",
    };
    agent = new FakeAgentRuntime(agentAppliesChange(change));

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("modified the task worktree");
    expect(outcome.reason).toContain(change.path);
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.planReview).toBeUndefined();
    expect((await storedTask()).status).toBe("READY");
    expect(existsSync(join(worktreePath, change.path))).toBe(true);
    await expectHeadAt(baseRevision);
  });

  it("fails the stage when the reviewer commits inside the worktree", async () => {
    agent = new FakeAgentRuntime(
      agentCommitsInWorktree({
        path: "src/sneaky.ts",
        content: "export const sneaky = true;\n",
      }),
    );

    const outcome = await executePlanReviewStage(await planReviewOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("no longer matches base revision");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the stage when the attempt has no persisted PLAN output to review", async () => {
    const attemptId2 = "att_M001_2";
    const worktreePath2 = join(worktreesDir, taskId, "attempt-2");
    await store.putAttempt({
      ...(await storedAttempt()),
      id: attemptId2,
      number: 2,
    });
    await git.createBranch(repoPath, "task/M001/attempt-2");
    await git.createWorktree(repoPath, worktreePath2, "task/M001/attempt-2");
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    const outcome = await executePlanReviewStage(
      await planReviewOptions({ attemptId: attemptId2, worktreePath: worktreePath2 }),
    );

    expectFailed(outcome);
    expect(outcome.reason).toContain("no persisted PLAN output to review");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(agent.invocations).toHaveLength(0);
  });

  it("behaves identically regardless of the agent provider identity", async () => {
    const attemptId2 = "att_M001_2";
    const worktreePath2 = join(worktreesDir, taskId, "attempt-2");
    await store.putAttempt({
      ...(await storedAttempt()),
      id: attemptId2,
      number: 2,
    });
    await store.putStageRun({
      id: planStageRunId(attemptId2),
      attemptId: attemptId2,
      stage: "PLAN",
      status: "SUCCEEDED",
      startedAt: FIXED_CLOCK,
      finishedAt: FIXED_CLOCK,
      output: { plan: PLAN_TEXT },
    });
    await git.createBranch(repoPath, "task/M001/attempt-2");
    await git.createWorktree(repoPath, worktreePath2, "task/M001/attempt-2");

    const outcomes: PlanReviewStageOutcome[] = [];
    for (const [index, providerId] of ["codex-like", "opencode-like"].entries()) {
      const providerAgent = new FakeAgentRuntime(
        agentReturnsReview({ decision: "APPROVED" }),
        { id: providerId },
      );
      agent = providerAgent;
      const isFirst = index === 0;
      outcomes.push(
        await executePlanReviewStage(
          await planReviewOptions(
            isFirst
              ? {}
              : { attemptId: attemptId2, worktreePath: worktreePath2 },
          ),
        ),
      );
      expect(providerAgent.invocations[0]?.agent.id).toBe(providerId);
      expect(providerAgent.invocations[0]?.instruction).toBe(
        PLAN_REVIEW_STAGE_INSTRUCTION,
      );
    }

    const [first, second] = outcomes;
    if (first === undefined || second === undefined) {
      throw new Error("expected two PLAN_REVIEW stage outcomes");
    }
    expectCompleted(first);
    expectCompleted(second);
    expect(first.decision).toBe(second.decision);
    expect(first.stageRun.status).toBe(second.stageRun.status);
    expect(first.stageRun.stage).toBe(second.stageRun.stage);
    expect(first.stageRun.id).toBe(planReviewStageRunId(attemptId));
    expect(second.stageRun.id).toBe(planReviewStageRunId(attemptId2));
    const reviewRuns = (await store.listStageRuns(attemptId)).concat(
      await store.listStageRuns(attemptId2),
    );
    const planReviewRuns = reviewRuns.filter((run) => run.stage === "PLAN_REVIEW");
    expect(planReviewRuns).toHaveLength(2);
    for (const run of planReviewRuns) {
      expect(run.output?.planReview).toEqual({ decision: "APPROVED" });
    }
  });

  it("rejects invalid stage options before creating a stage run", async () => {
    agent = new FakeAgentRuntime(agentReturnsReview({ decision: "APPROVED" }));

    await expect(
      executePlanReviewStage(await planReviewOptions({ timeoutMs: 0 })),
    ).rejects.toThrow("timeoutMs must be a positive finite number");
    await expect(
      executePlanReviewStage(await planReviewOptions({ attemptId: "  " })),
    ).rejects.toThrow("attemptId must be a non-empty string");
    expect(agent.invocations).toHaveLength(0);
    expect(await store.listStageRuns(attemptId)).toHaveLength(1);
  });
});
