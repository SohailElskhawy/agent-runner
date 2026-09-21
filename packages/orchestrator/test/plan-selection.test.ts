import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentDescriptor } from "@agentic-dev-runner/agents";
import type { AgentExecutionResult } from "@agentic-dev-runner/agents";
import type { AgentInvocation, AgentRuntime } from "@agentic-dev-runner/agents";
import type { Attempt, StageRun } from "@agentic-dev-runner/core";
import { executeCodeReviewStage } from "../src/code-review-stage.js";
import { executePlanReviewStage } from "../src/plan-review-stage.js";
import { planReviewStageRunId } from "../src/plan-review-stage.js";
import { executePlanReviewFixLoop } from "../src/review-fix-loop.js";
import { planStageRunId } from "../src/plan-stage.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  runFixtureGit,
} from "./fixtures.js";

const taskId = "M001";
const attemptId = `att_${taskId}_1`;
const branch = `task/${taskId}/attempt-1`;
const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

type AgentBehavior = (
  invocation: AgentInvocation,
) => AgentExecutionResult | Promise<AgentExecutionResult>;

class ScriptedAgentRuntime implements AgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly invocations: AgentInvocation[] = [];
  private readonly queue: AgentBehavior[];
  constructor(behaviors: readonly AgentBehavior[]) {
    this.descriptor = { id: "fake-agent" };
    this.queue = [...behaviors];
  }
  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    this.invocations.push(invocation);
    const behavior = this.queue.shift();
    if (behavior === undefined) {
      throw new Error("unexpected agent invocation");
    }
    return await behavior(invocation);
  }
}

function agentPlans(text: string): AgentBehavior {
  return () => ({
    kind: "success",
    output: { stdout: text, stderr: "" },
    exitCode: 0,
    durationMs: 5,
  });
}

function agentReviews(review: {
  readonly decision: "APPROVED" | "CHANGES_REQUIRED";
  readonly feedback?: string;
}): AgentBehavior {
  return () => ({
    kind: "success",
    output: { stdout: JSON.stringify(review), stderr: "" },
    exitCode: 0,
    durationMs: 5,
  });
}

function planTextOf(cycle: number): string {
  return `PLAN VERSION ${String(cycle)}`;
}

let directory: string;
let repoPath: string;
let worktreesDir: string;
let worktreePath: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let baseRevision: string;

async function seedAttempt(): Promise<void> {
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
}

async function seedPlanRun(cycle: number, planText: string): Promise<void> {
  await store.putStageRun({
    id: planStageRunId(attemptId, cycle),
    attemptId,
    stage: "PLAN",
    status: "SUCCEEDED",
    startedAt: FIXED_CLOCK,
    finishedAt: FIXED_CLOCK,
    output: { plan: planText },
  });
}

async function seedFailedPlanRun(cycle: number): Promise<void> {
  await store.putStageRun({
    id: planStageRunId(attemptId, cycle),
    attemptId,
    stage: "PLAN",
    status: "FAILED",
    startedAt: FIXED_CLOCK,
    finishedAt: FIXED_CLOCK,
    failure: { kind: "error", message: "plan agent failed" },
  });
}

async function seedPlanReviewRun(
  cycle: number,
  review: { readonly decision: "APPROVED" | "CHANGES_REQUIRED"; readonly feedback?: string },
): Promise<void> {
  await store.putStageRun({
    id: planReviewStageRunId(attemptId, cycle),
    attemptId,
    stage: "PLAN_REVIEW",
    status: "SUCCEEDED",
    startedAt: FIXED_CLOCK,
    finishedAt: FIXED_CLOCK,
    output: { planReview: review, stdout: JSON.stringify(review) },
  });
}

/**
 * Seeds the attempt's implementation as a committed delta so CODE_REVIEW has
 * real implementation evidence to review.
 */
async function seedCommittedImplementation(): Promise<void> {
  const target = join(worktreePath, "src", "utils.ts");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "export const add = (a: number, b: number): number => a + b;\n");
  await runFixtureGit(runner, worktreePath, ["add", "src/utils.ts"]);
  await runFixtureGit(runner, worktreePath, [
    "commit",
    "-m",
    "attempt: implement task M001",
  ]);
}

function stageRunById(runs: readonly StageRun[], id: string): StageRun {
  const run = runs.find((candidate) => candidate.id === id);
  if (run === undefined) {
    throw new Error(`stage run "${id}" not found`);
  }
  return run;
}

function sortedIds(runs: readonly StageRun[]): string[] {
  return runs.map((run) => run.id).sort();
}

function contextDocument(
  invocation: AgentInvocation | undefined,
  path: string,
): string | undefined {
  return invocation?.contextPack.documents.find(
    (document) => document.path === path,
  )?.content;
}

async function storedTask(): Promise<ReturnType<typeof createTask>> {
  const task = await store.getTask(taskId);
  if (task === null) {
    throw new Error(`task "${taskId}" not found in store`);
  }
  return task;
}

describe("PLAN_REVIEW deterministic cycle pairing", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-plan-sel-"));
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
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function reviewOptions(
    agent: AgentRuntime,
    overrides: Partial<Parameters<typeof executePlanReviewStage>[0]> = {},
  ): Parameters<typeof executePlanReviewStage>[0] {
    return {
      store,
      git,
      agent,
      task: undefined as unknown as Awaited<ReturnType<typeof storedTask>>,
      attemptId,
      worktreePath,
      baseRevision,
      timeoutMs: 5_000,
      now: () => FIXED_CLOCK,
      ...overrides,
    };
  }

  it("pairs a cycle-scoped PLAN_REVIEW with its own PLAN cycle identity", async () => {
    await seedPlanRun(1, planTextOf(1));
    await seedPlanRun(2, planTextOf(2));
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executePlanReviewStage(
      reviewOptions(agent, { task, cycle: 2 }),
    );

    expect(outcome.kind).toBe("completed");
    expect(contextDocument(agent.invocations[0], "PLAN")).toBe(planTextOf(2));
    expect(outcome.kind === "completed" && outcome.stageRun.id).toBe(
      planReviewStageRunId(attemptId, 2),
    );
  });

  it("pairs review cycle 1 with the base PLAN identity", async () => {
    await seedPlanRun(1, planTextOf(1));
    await seedPlanRun(2, planTextOf(2));
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executePlanReviewStage(
      reviewOptions(agent, { task, cycle: 1 }),
    );

    expect(outcome.kind).toBe("completed");
    expect(contextDocument(agent.invocations[0], "PLAN")).toBe(planTextOf(1));
  });

  it("keeps the standalone latest-successful-PLAN fallback when no cycle is given", async () => {
    await seedPlanRun(1, planTextOf(1));
    await seedPlanRun(2, planTextOf(2));
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executePlanReviewStage(reviewOptions(agent, { task }));

    expect(outcome.kind).toBe("completed");
    expect(contextDocument(agent.invocations[0], "PLAN")).toBe(planTextOf(2));
    expect(outcome.kind === "completed" && outcome.stageRun.id).toBe(
      planReviewStageRunId(attemptId),
    );
  });

  it("fails explicitly when the paired PLAN cycle run does not exist", async () => {
    await seedPlanRun(1, planTextOf(1));
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executePlanReviewStage(
      reviewOptions(agent, { task, cycle: 3 }),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain(`review cycle 3`);
    expect(outcome.reason).toContain(planStageRunId(attemptId, 3));
    expect(agent.invocations).toHaveLength(0);
    expect(outcome.stageRun.status).toBe("FAILED");
  });

  it("fails explicitly when the paired PLAN cycle run did not succeed", async () => {
    await seedFailedPlanRun(3);
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executePlanReviewStage(
      reviewOptions(agent, { task, cycle: 3 }),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain(`review cycle 3`);
    expect(agent.invocations).toHaveLength(0);
  });
});

describe("CODE_REVIEW deterministic PLAN context selection", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-code-sel-"));
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
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function codeReviewOptions(
    agent: AgentRuntime,
    task: Awaited<ReturnType<typeof storedTask>>,
  ): Parameters<typeof executeCodeReviewStage>[0] {
    return {
      store,
      git,
      agent,
      task,
      attemptId,
      worktreePath,
      baseRevision,
      timeoutMs: 5_000,
      now: () => FIXED_CLOCK,
    };
  }

  it("reviews the PLAN approved by the highest-cycle APPROVED PLAN_REVIEW, not lexicographic order", async () => {
    for (let cycle = 1; cycle <= 11; cycle += 1) {
      await seedPlanRun(cycle, planTextOf(cycle));
      if (cycle <= 9) {
        await seedPlanReviewRun(cycle, {
          decision: "CHANGES_REQUIRED",
          feedback: `fix ${String(cycle)}`,
        });
      } else if (cycle === 10) {
        await seedPlanReviewRun(cycle, { decision: "APPROVED" });
      } else {
        await seedPlanReviewRun(cycle, {
          decision: "CHANGES_REQUIRED",
          feedback: `fix ${String(cycle)}`,
        });
      }
    }
    await seedCommittedImplementation();
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executeCodeReviewStage(codeReviewOptions(agent, task));

    expect(outcome.kind).toBe("completed");
    expect(contextDocument(agent.invocations[0], "PLAN")).toBe(planTextOf(10));
  });

  it("falls back to the highest-cycle successful PLAN when no plan review approved", async () => {
    await seedPlanRun(1, planTextOf(1));
    await seedPlanRun(2, planTextOf(2));
    await seedPlanRun(10, planTextOf(10));
    await seedCommittedImplementation();
    const agent = new ScriptedAgentRuntime([agentReviews({ decision: "APPROVED" })]);
    const task = await storedTask();

    const outcome = await executeCodeReviewStage(codeReviewOptions(agent, task));

    expect(outcome.kind).toBe("completed");
    expect(contextDocument(agent.invocations[0], "PLAN")).toBe(planTextOf(10));
  });
});

describe("PLAN review/fix loop with a fixed clock beyond cycle 9", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-loop-c10-"));
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
    const task = createTask({ id: taskId, status: "READY" });
    task.definition = {
      ...task.definition,
      limits: { ...task.definition.limits, maxReviewCycles: 12 },
    };
    await store.putTask(task);
    await seedAttempt();
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reviews each cycle's own PLAN even when `_c10`/`_c11` sort before `_c2`", async () => {
    const behaviors: AgentBehavior[] = [];
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      behaviors.push(agentPlans(planTextOf(cycle)));
      if (cycle < 12) {
        behaviors.push(
          agentReviews({
            decision: "CHANGES_REQUIRED",
            feedback: `fix ${String(cycle)}`,
          }),
        );
      } else {
        behaviors.push(agentReviews({ decision: "APPROVED" }));
      }
    }
    const agent = new ScriptedAgentRuntime(behaviors);
    const task = await store.getTask(taskId);
    if (task === null) throw new Error("task missing");

    const outcome = await executePlanReviewFixLoop({
      store,
      git,
      agent,
      task,
      attemptId,
      worktreePath,
      baseRevision,
      timeoutMs: 5_000,
      now: () => FIXED_CLOCK,
    });

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    expect(outcome.reviewCycles).toBe(12);
    expect(outcome.decision).toBe("APPROVED");
    expect(agent.invocations).toHaveLength(24);

    for (let cycle = 1; cycle <= 12; cycle += 1) {
      const reviewInvocation = agent.invocations[cycle * 2 - 1];
      expect(contextDocument(reviewInvocation, "PLAN")).toBe(planTextOf(cycle));
    }

    const runs = await store.listStageRuns(attemptId);
    expect(runs).toHaveLength(24);
    const expectedIds: string[] = [];
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      expectedIds.push(planStageRunId(attemptId, cycle));
      expectedIds.push(planReviewStageRunId(attemptId, cycle));
    }
    expect(sortedIds(runs)).toEqual(expectedIds.sort());
    expect(stageRunById(runs, planStageRunId(attemptId, 10)).output?.plan).toBe(
      planTextOf(10),
    );
    expect(stageRunById(runs, planStageRunId(attemptId, 11)).output?.plan).toBe(
      planTextOf(11),
    );
  }, 15_000);

  it("works with normal advancing timestamps across multiple cycles", async () => {
    const behaviors: AgentBehavior[] = [
      agentPlans(planTextOf(1)),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: "fix 1" }),
      agentPlans(planTextOf(2)),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: "fix 2" }),
      agentPlans(planTextOf(3)),
      agentReviews({ decision: "APPROVED" }),
    ];
    const agent = new ScriptedAgentRuntime(behaviors);
    const task = await store.getTask(taskId);
    if (task === null) throw new Error("task missing");
    const taskWithLimit = {
      ...task,
      definition: {
        ...task.definition,
        limits: { ...task.definition.limits, maxReviewCycles: 3 },
      },
    };

    let tick = 0;
    const outcome = await executePlanReviewFixLoop({
      store,
      git,
      agent,
      task: taskWithLimit,
      attemptId,
      worktreePath,
      baseRevision,
      timeoutMs: 5_000,
      now: () =>
        new Date(Date.parse(FIXED_CLOCK) + tick++ * 1_000).toISOString(),
    });

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    expect(outcome.reviewCycles).toBe(3);
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const reviewInvocation = agent.invocations[cycle * 2 - 1];
      expect(contextDocument(reviewInvocation, "PLAN")).toBe(planTextOf(cycle));
    }
    const runs = await store.listStageRuns(attemptId);
    expect(runs).toHaveLength(6);
    expect(sortedIds(runs)).toEqual(
      [
        planStageRunId(attemptId, 1),
        planReviewStageRunId(attemptId, 1),
        planStageRunId(attemptId, 2),
        planReviewStageRunId(attemptId, 2),
        planStageRunId(attemptId, 3),
        planReviewStageRunId(attemptId, 3),
      ].sort(),
    );
    expect(stageRunById(runs, planStageRunId(attemptId, 3)).output?.plan).toBe(
      planTextOf(3),
    );
  });
});
