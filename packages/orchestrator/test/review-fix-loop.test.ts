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
import type { Attempt, StageRun, Task } from "@agentic-dev-runner/core";
import { OrchestrationError } from "../src/orchestration-error.js";
import {
  executeCodeReviewFixLoop,
  executePlanReviewFixLoop,
} from "../src/review-fix-loop.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  runFixtureGit,
} from "./fixtures.js";

function writeChangeAt(
  worktreePath: string,
  relativePath: string,
  content: string,
): void {
  const target = join(worktreePath, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const taskId = "M001";
const attemptId = `att_${taskId}_1`;
const branch = `task/${taskId}/attempt-1`;

const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

const PLAN_ONE = "PLAN v1: add the utility function.";
const PLAN_TWO = "PLAN v2: add the validated utility function with tests.";
const IMPLEMENTATION_ONE =
  "export const add = (a: number, b: number): number => a + b;\n";
const IMPLEMENTATION_TWO =
  "export const validatedAdd = (a: number, b: number): number => a + b;\n";
const FEEDBACK =
  "Add input validation for rejected inputs and cover them with tests.";

type AgentBehavior = (
  invocation: AgentInvocation,
) => AgentExecutionResult | Promise<AgentExecutionResult>;

class ScriptedAgentRuntime implements AgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly invocations: AgentInvocation[] = [];
  private readonly queue: AgentBehavior[];

  constructor(
    descriptor: Partial<AgentDescriptor>,
    behaviors: readonly AgentBehavior[],
  ) {
    this.descriptor = {
      id: descriptor.id ?? "fake-agent",
      ...(descriptor.model === undefined ? {} : { model: descriptor.model }),
    };
    this.queue = [...behaviors];
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    this.invocations.push(invocation);
    const behavior = this.queue.shift();
    if (behavior === undefined) {
      throw new Error(
        "unexpected agent invocation: scripted behavior queue is empty",
      );
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

function agentImplements(path: string, content: string): AgentBehavior {
  return (invocation) => {
    writeChangeAt(invocation.worktreePath, path, content);
    return {
      kind: "success",
      output: { stdout: `wrote ${path}`, stderr: "" },
      exitCode: 0,
      durationMs: 5,
    };
  };
}

function agentFails(message: string): AgentBehavior {
  return () => ({
    kind: "failure",
    failure: { kind: "process", message },
    output: { stdout: "partial output", stderr: message },
    durationMs: 5,
  });
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

async function seedTaskWithReviewLimit(maxReviewCycles: number): Promise<Task> {
  const task = createTask({ id: taskId, status: "READY" });
  task.definition = {
    ...task.definition,
    limits: { ...task.definition.limits, maxReviewCycles },
  };
  await store.putTask(task);
  return task;
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

function stageRunById(runs: readonly StageRun[], id: string): StageRun {
  const run = runs.find((candidate) => candidate.id === id);
  if (run === undefined) {
    throw new Error(`stage run "${id}" not found`);
  }
  return run;
}

/**
 * `listStageRuns` orders by (started_at, id); with a fixed test clock the id
 * ordering dominates, so persistence assertions compare identity sets
 * order-independently.
 */
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

describe("executePlanReviewFixLoop (M058b)", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m058b-plan-"));
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
    await seedTaskWithReviewLimit(2);
    await seedAttempt();
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function loopOptions(agent: AgentRuntime, task: Task) {
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

  it("passes the review gate on the first APPROVED PLAN_REVIEW", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentPlans(PLAN_ONE),
      agentReviews({ decision: "APPROVED" }),
    ]);

    const outcome = await executePlanReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    expect(outcome.reviewCycles).toBe(1);
    expect(outcome.stageRuns.map((run) => run.id)).toEqual([
      `stage_${attemptId}_PLAN`,
      `stage_${attemptId}_PLAN_REVIEW`,
    ]);
    expect(agent.invocations).toHaveLength(2);
  });

  it("reruns PLAN with review feedback and is then approved", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentPlans(PLAN_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
      agentPlans(PLAN_TWO),
      agentReviews({ decision: "APPROVED" }),
    ]);

    const outcome = await executePlanReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    expect(outcome.reviewCycles).toBe(2);
    expect(agent.invocations).toHaveLength(4);

    const fixPlanInvocation = agent.invocations[2];
    expect(contextDocument(fixPlanInvocation, "REVIEW_FEEDBACK")).toBe(
      FEEDBACK,
    );

    const revisedReviewInvocation = agent.invocations[3];
    expect(contextDocument(revisedReviewInvocation, "PLAN")).toBe(PLAN_TWO);
  });

  it("returns an explicit review-limit-exhausted result when the budget is used up", async () => {
    const task = await seedTaskWithReviewLimit(1);
    const agent = new ScriptedAgentRuntime({}, [
      agentPlans(PLAN_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
    ]);

    const outcome = await executePlanReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("review-limit-exhausted");
    if (outcome.kind !== "review-limit-exhausted") return;
    expect(outcome.reviewCycles).toBe(1);
    expect(outcome.feedback).toBe(FEEDBACK);
    expect(agent.invocations).toHaveLength(2);
    const runs = await store.listStageRuns(attemptId);
    expect(runs.map((run) => run.stage)).toEqual(["PLAN", "PLAN_REVIEW"]);
  });

  it("returns a failed outcome when the PLAN stage fails and runs no review", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentFails("planning agent crashed"),
    ]);

    const outcome = await executePlanReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("agent failed: planning agent crashed");
    expect(outcome.stageRuns).toHaveLength(1);
    expect(outcome.stageRuns[0]?.status).toBe("FAILED");
    expect(agent.invocations).toHaveLength(1);
  });

  it("preserves every cycle's StageRun history", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentPlans(PLAN_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
      agentPlans(PLAN_TWO),
      agentReviews({ decision: "APPROVED" }),
    ]);

    const outcome = await executePlanReviewFixLoop(loopOptions(agent, task));
    expect(outcome.kind).toBe("approved");

    const runs = await store.listStageRuns(attemptId);
    expect(sortedIds(runs)).toEqual(
      [
        `stage_${attemptId}_PLAN`,
        `stage_${attemptId}_PLAN_REVIEW`,
        `stage_${attemptId}_PLAN_c2`,
        `stage_${attemptId}_PLAN_REVIEW_c2`,
      ].sort(),
    );
    expect(stageRunById(runs, `stage_${attemptId}_PLAN`).output?.plan).toBe(
      PLAN_ONE,
    );
    expect(
      stageRunById(runs, `stage_${attemptId}_PLAN_c2`).output?.plan,
    ).toBe(PLAN_TWO);
    expect(
      stageRunById(runs, `stage_${attemptId}_PLAN_REVIEW`).output?.planReview,
    ).toEqual({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK });
    expect(
      stageRunById(runs, `stage_${attemptId}_PLAN_REVIEW_c2`).output
        ?.planReview,
    ).toEqual({ decision: "APPROVED" });
  });

  it("leaves task state, events, and the worktree untouched", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentPlans(PLAN_ONE),
      agentReviews({ decision: "APPROVED" }),
    ]);

    await executePlanReviewFixLoop(loopOptions(agent, task));

    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
    expect(await store.listEvents()).toHaveLength(0);
    expect(
      await runFixtureGit(runner, repoPath, ["rev-parse", branch]),
    ).toBe(`${baseRevision}\n`);
  });

  it("rejects an invalid maxReviewCycles configuration", async () => {
    const task = await seedTaskWithReviewLimit(0);
    const agent = new ScriptedAgentRuntime({}, []);

    await expect(
      executePlanReviewFixLoop(loopOptions(agent, task)),
    ).rejects.toBeInstanceOf(OrchestrationError);
  });
});

describe("executeCodeReviewFixLoop (M058b)", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m058b-code-"));
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
    await seedTaskWithReviewLimit(2);
    await seedAttempt();
    await git.createBranch(repoPath, branch);
    await git.createWorktree(repoPath, worktreePath, branch);
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function loopOptions(agent: AgentRuntime, task: Task) {
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

  it("passes the review gate on the first APPROVED CODE_REVIEW", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentImplements("src/utils.ts", IMPLEMENTATION_ONE),
      agentReviews({ decision: "APPROVED" }),
    ]);

    const outcome = await executeCodeReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    expect(outcome.reviewCycles).toBe(1);
    expect(outcome.stageRuns.map((run) => run.id)).toEqual([
      `stage_${attemptId}_IMPLEMENT`,
      `stage_${attemptId}_CODE_REVIEW`,
    ]);
    expect(agent.invocations).toHaveLength(2);
  });

  it("reruns IMPLEMENT with review feedback and is then approved", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentImplements("src/utils.ts", IMPLEMENTATION_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
      agentImplements("src/validation.ts", IMPLEMENTATION_TWO),
      agentReviews({ decision: "APPROVED" }),
    ]);

    const outcome = await executeCodeReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") return;
    expect(outcome.reviewCycles).toBe(2);
    expect(agent.invocations).toHaveLength(4);

    const fixInvocation = agent.invocations[2];
    expect(contextDocument(fixInvocation, "REVIEW_FEEDBACK")).toBe(FEEDBACK);
  });

  it("returns an explicit review-limit-exhausted result when the budget is used up", async () => {
    const task = await seedTaskWithReviewLimit(1);
    const agent = new ScriptedAgentRuntime({}, [
      agentImplements("src/utils.ts", IMPLEMENTATION_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
    ]);

    const outcome = await executeCodeReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("review-limit-exhausted");
    if (outcome.kind !== "review-limit-exhausted") return;
    expect(outcome.reviewCycles).toBe(1);
    expect(outcome.feedback).toBe(FEEDBACK);
    expect(agent.invocations).toHaveLength(2);
    const runs = await store.listStageRuns(attemptId);
    expect(runs.filter((run) => run.stage === "IMPLEMENT")).toHaveLength(1);
    expect(runs.filter((run) => run.stage === "CODE_REVIEW")).toHaveLength(1);
  });

  it("enforces the exact configured review-cycle limit", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentImplements("src/utils.ts", IMPLEMENTATION_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
      agentImplements("src/validation.ts", IMPLEMENTATION_TWO),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
    ]);

    const outcome = await executeCodeReviewFixLoop(loopOptions(agent, task));

    expect(outcome.kind).toBe("review-limit-exhausted");
    if (outcome.kind !== "review-limit-exhausted") return;
    expect(outcome.reviewCycles).toBe(2);
    expect(agent.invocations).toHaveLength(4);
    const runs = await store.listStageRuns(attemptId);
    expect(runs.filter((run) => run.stage === "CODE_REVIEW")).toHaveLength(2);
    expect(runs.filter((run) => run.stage === "IMPLEMENT")).toHaveLength(2);
  });

  it("preserves every cycle's StageRun history", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentImplements("src/utils.ts", IMPLEMENTATION_ONE),
      agentReviews({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK }),
      agentImplements("src/validation.ts", IMPLEMENTATION_TWO),
      agentReviews({ decision: "APPROVED" }),
    ]);

    const outcome = await executeCodeReviewFixLoop(loopOptions(agent, task));
    expect(outcome.kind).toBe("approved");

    const runs = await store.listStageRuns(attemptId);
    expect(sortedIds(runs)).toEqual(
      [
        `stage_${attemptId}_IMPLEMENT`,
        `stage_${attemptId}_CODE_REVIEW`,
        `stage_${attemptId}_IMPLEMENT_c2`,
        `stage_${attemptId}_CODE_REVIEW_c2`,
      ].sort(),
    );
    expect(
      stageRunById(runs, `stage_${attemptId}_IMPLEMENT`).output?.stdout,
    ).toBe("wrote src/utils.ts");
    expect(
      stageRunById(runs, `stage_${attemptId}_IMPLEMENT_c2`).output?.stdout,
    ).toBe("wrote src/validation.ts");
    expect(
      stageRunById(runs, `stage_${attemptId}_CODE_REVIEW`).output?.codeReview,
    ).toEqual({ decision: "CHANGES_REQUIRED", feedback: FEEDBACK });
    expect(
      stageRunById(runs, `stage_${attemptId}_CODE_REVIEW_c2`).output
        ?.codeReview,
    ).toEqual({ decision: "APPROVED" });
  });

  it("never stages, commits, integrates, or mutates task state", async () => {
    const task = await storedTask();
    const agent = new ScriptedAgentRuntime({}, [
      agentImplements("src/utils.ts", IMPLEMENTATION_ONE),
      agentReviews({ decision: "APPROVED" }),
    ]);

    await executeCodeReviewFixLoop(loopOptions(agent, task));

    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
    expect(await store.listEvents()).toHaveLength(0);
    expect(
      await runFixtureGit(runner, repoPath, ["rev-parse", branch]),
    ).toBe(`${baseRevision}\n`);
    const worktreeStatus = await git.status(worktreePath);
    expect(worktreeStatus.clean).toBe(false);
    expect(worktreeStatus.entries[0]?.indexStatus).toBe("?");
  });

  it("rejects an invalid maxReviewCycles configuration", async () => {
    const task = await seedTaskWithReviewLimit(-1);
    const agent = new ScriptedAgentRuntime({}, []);

    await expect(
      executeCodeReviewFixLoop(loopOptions(agent, task)),
    ).rejects.toBeInstanceOf(OrchestrationError);
  });
});
