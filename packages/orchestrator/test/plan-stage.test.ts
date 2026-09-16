import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  PLAN_STAGE_INSTRUCTION,
  executePlanStage,
  planStageRunId,
  type PlanStageOptions,
  type PlanStageOutcome,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  agentAppliesChange,
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

function agentReturnsPlan(text: string): AgentBehavior {
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
    output: { stdout: "", stderr: "no plan today" },
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
      "plan agent should not commit",
    ]);
    return {
      kind: "success",
      output: { stdout: "committed", stderr: "" },
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

function expectSucceeded(
  outcome: PlanStageOutcome,
): asserts outcome is Extract<PlanStageOutcome, { kind: "succeeded" }> {
  if (outcome.kind !== "succeeded") {
    throw new Error(
      `expected a succeeded PLAN outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailed(
  outcome: PlanStageOutcome,
): asserts outcome is Extract<PlanStageOutcome, { kind: "failed" }> {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed PLAN outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
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

describe("executePlanStage (M052a)", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m052a-"));
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
    agent = new FakeAgentRuntime();
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function planOptions(
    overrides: Partial<PlanStageOptions> = {},
  ): Promise<PlanStageOptions> {
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

  it("runs a successful PLAN invocation that requests a plan, not implementation", async () => {
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    const outcome = await executePlanStage(await planOptions());

    expectSucceeded(outcome);
    expect(outcome.plan).toBe(PLAN_TEXT);
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.failure).toBeUndefined();
    expect(agent.invocations).toHaveLength(1);
    const invocation = agent.invocations[0];
    expect(invocation?.instruction).toBe(PLAN_STAGE_INSTRUCTION);
    expect(PLAN_STAGE_INSTRUCTION).toContain("planning only");
    expect(PLAN_STAGE_INSTRUCTION).toContain("Do NOT");
    expect(invocation?.contextPack.task.id).toBe(taskId);
    expect(invocation?.contextPack.task.definition.objective).toBe(
      "Add one validated utility function.",
    );
    expect(invocation?.contextPack.agentsMarkdown).toBe(AGENTS_MARKDOWN);
    expect(invocation?.contextPack.baseRevision).toBe(baseRevision);
    expect(invocation?.worktreePath).toBe(worktreePath);
    expect(invocation?.timeoutMs).toBe(5_000);
  });

  it("captures and persists the plan text retrievable by the later PLAN_REVIEW stage", async () => {
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    const outcome = await executePlanStage(await planOptions());
    expectSucceeded(outcome);

    const stageRuns = await store.listStageRuns(attemptId);
    const planRun = stageRuns.find((run) => run.stage === "PLAN");
    expect(planRun).toBeDefined();
    expect(planRun?.status).toBe("SUCCEEDED");
    expect(planRun?.output?.plan).toBe(PLAN_TEXT);

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      const durableRuns = await reopened.listStageRuns(attemptId);
      const durablePlanRun = durableRuns.find((run) => run.stage === "PLAN");
      expect(durablePlanRun?.output?.plan).toBe(PLAN_TEXT);
    } finally {
      await reopened.close();
    }
  });

  it("uses the deterministic PLAN StageRun identity on the attempt", async () => {
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    const outcome = await executePlanStage(await planOptions());

    expectSucceeded(outcome);
    expect(outcome.stageRun.id).toBe(planStageRunId(attemptId));
    expect(outcome.stageRun.id).toBe(`stage_${attemptId}_PLAN`);
    expect(outcome.stageRun.attemptId).toBe(attemptId);
    expect(outcome.stageRun.stage).toBe("PLAN");
    expect(outcome.stageRun.startedAt).toBe(FIXED_CLOCK);
    const stageRuns = await store.listStageRuns(attemptId);
    expect(stageRuns).toHaveLength(1);
    expect(stageRuns[0]?.id).toBe(outcome.stageRun.id);
  });

  it("does not transition the task state, verify, commit, integrate, or write into the worktree", async () => {
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    const beforeEvents = await store.listEvents();
    const outcome = await executePlanStage(await planOptions());

    expectSucceeded(outcome);
    expect((await storedTask()).status).toBe("READY");
    expect(await store.getTaskStatus(taskId)).toBe("READY");
    expect(await store.listEvents()).toEqual(beforeEvents);
    expect(existsSync(join(worktreePath, "src"))).toBe(false);
    await expectHeadAt(baseRevision);
    const attempt = await storedAttempt();
    expect(attempt.status).toBe("RUNNING");
    expect(attempt.logs).toBeUndefined();
  });

  it("marks the stage TIMED_OUT when the agent invocation times out", async () => {
    agent = new FakeAgentRuntime(agentTimesOut());

    const outcome = await executePlanStage(await planOptions());

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

    const outcome = await executePlanStage(await planOptions());

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure?.kind).toBe("cancelled");
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the stage without task completion when the agent process fails", async () => {
    agent = new FakeAgentRuntime(agentFails("agent crashed with code 3"));

    const outcome = await executePlanStage(await planOptions());

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

  it("fails the PLAN stage when the agent modifies worktree source files", async () => {
    const change = {
      path: "worktree-mutation.ts",
      content: "export const add = (a: number, b: number): number => a + b;\n",
    };
    agent = new FakeAgentRuntime(agentAppliesChange(change));

    const outcome = await executePlanStage(await planOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("modified the task worktree");
    expect(outcome.reason).toContain(change.path);
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.plan).toBeUndefined();
    expect((await storedTask()).status).toBe("READY");
    expect(existsSync(join(worktreePath, change.path))).toBe(true);
    await expectHeadAt(baseRevision);
  });

  it("fails the PLAN stage when the agent modifies nested source files", async () => {
    const change = {
      path: "src/utils.ts",
      content: "export const add = (a: number, b: number): number => a + b;\n",
    };
    agent = new FakeAgentRuntime((invocation) => {
      writeWorktreeFile(invocation.worktreePath, change.path, change.content);
      return {
        kind: "success",
        output: { stdout: "wrote src/utils.ts", stderr: "" },
        exitCode: 0,
        durationMs: 5,
      };
    });

    const outcome = await executePlanStage(await planOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("modified the task worktree");
    expect(outcome.reason).toContain("src/");
    expect(outcome.stageRun.status).toBe("FAILED");
    await expectHeadAt(baseRevision);
  });

  it("fails the PLAN stage when the agent commits inside the worktree", async () => {
    agent = new FakeAgentRuntime(
      agentCommitsInWorktree({
        path: "src/sneaky.ts",
        content: "export const sneaky = true;\n",
      }),
    );

    const outcome = await executePlanStage(await planOptions());

    expectFailed(outcome);
    expect(outcome.reason).toContain("no longer matches base revision");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect((await storedTask()).status).toBe("READY");
  });

  it("fails the PLAN stage when the agent produces no plan text", async () => {
    agent = new FakeAgentRuntime(agentProducesEmptyOutput());

    const outcome = await executePlanStage(await planOptions());

    expectFailed(outcome);
    expect(outcome.reason).toBe("the agent produced no plan text");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output).toEqual({
      stdout: "",
      stderr: "no plan today",
    });
  });

  it("cancels the stage before invoking the agent when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    const outcome = await executePlanStage(
      await planOptions({ signal: controller.signal }),
    );

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure?.kind).toBe("cancelled");
    expect(agent.invocations).toHaveLength(0);
  });

  it("fails the stage when AGENTS.md is missing from the worktree", async () => {
    const emptyWorktree = join(worktreesDir, taskId, "attempt-2");
    await git.createBranch(repoPath, "task/M001/attempt-2");
    await git.createWorktree(repoPath, emptyWorktree, "task/M001/attempt-2");
    rmSync(join(emptyWorktree, "AGENTS.md"));
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    const outcome = await executePlanStage(
      await planOptions({ worktreePath: emptyWorktree }),
    );

    expectFailed(outcome);
    expect(outcome.reason).toContain("AGENTS.md");
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
    await git.createBranch(repoPath, "task/M001/attempt-2");
    await git.createWorktree(repoPath, worktreePath2, "task/M001/attempt-2");

    const outcomes: PlanStageOutcome[] = [];
    for (const [index, providerId] of ["codex-like", "opencode-like"].entries()) {
      const providerAgent = new FakeAgentRuntime(
        agentReturnsPlan(PLAN_TEXT),
        { id: providerId },
      );
      agent = providerAgent;
      const isFirst = index === 0;
      outcomes.push(
        await executePlanStage(
          await planOptions(
            isFirst
              ? {}
              : { attemptId: attemptId2, worktreePath: worktreePath2 },
          ),
        ),
      );
      expect(providerAgent.invocations[0]?.agent.id).toBe(providerId);
      expect(providerAgent.invocations[0]?.instruction).toBe(
        PLAN_STAGE_INSTRUCTION,
      );
    }

    const [first, second] = outcomes;
    if (first === undefined || second === undefined) {
      throw new Error("expected two PLAN stage outcomes");
    }
    expectSucceeded(first);
    expectSucceeded(second);
    expect(first.plan).toBe(second.plan);
    expect(first.stageRun.status).toBe(second.stageRun.status);
    expect(first.stageRun.stage).toBe(second.stageRun.stage);
    expect(first.stageRun.id).toBe(planStageRunId(attemptId));
    expect(second.stageRun.id).toBe(planStageRunId(attemptId2));
    const planRuns = (await store.listStageRuns(attemptId)).concat(
      await store.listStageRuns(attemptId2),
    );
    expect(planRuns).toHaveLength(2);
    for (const run of planRuns) {
      expect(run.output?.plan).toBe(PLAN_TEXT);
      expect(run.stage).toBe("PLAN");
    }
  });

  it("rejects invalid stage options before creating a stage run", async () => {
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    await expect(
      executePlanStage(await planOptions({ timeoutMs: 0 })),
    ).rejects.toThrow("timeoutMs must be a positive finite number");
    await expect(
      executePlanStage(await planOptions({ attemptId: "  " })),
    ).rejects.toThrow("attemptId must be a non-empty string");
    expect(agent.invocations).toHaveLength(0);
    expect(await store.listStageRuns(attemptId)).toEqual([]);
  });

  it("rejects a PLAN stage run for an unknown attempt", async () => {
    agent = new FakeAgentRuntime(agentReturnsPlan(PLAN_TEXT));

    await expect(
      executePlanStage(await planOptions({ attemptId: "att_unknown_1" })),
    ).rejects.toThrow(/att_unknown_1/);
    expect(agent.invocations).toHaveLength(0);
  });
});
