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
import type { Attempt, Task } from "@agentic-dev-runner/core";
import {
  IMPLEMENT_STAGE_INSTRUCTION,
  executeImplementStage,
  implementStageRunId,
  type ImplementStageOptions,
  type ImplementStageOutcome,
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
} from "./fixtures.js";
import type { AgentBehavior } from "./fixtures.js";

function writeChangeAt(
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
    writeChangeAt(invocation.worktreePath, change.path, change.content);
    return {
      kind: "success",
      output: { stdout: `wrote ${change.path}`, stderr: "" },
      exitCode: 0,
      durationMs: 5,
    };
  };
}

const taskId = "M001";
const attemptId = `att_${taskId}_1`;
const branch = `task/${taskId}/attempt-1`;

const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

const PLAN_TEXT = [
  "# Implementation plan",
  "1. Add `src/utils.ts` with a validated `add` function.",
  "2. Cover the function with unit tests.",
].join("\n");

const REVIEW_FEEDBACK =
  "The implementation is missing input validation; validate inputs and cover rejected inputs with tests.";

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
  outcome: ImplementStageOutcome,
): asserts outcome is Extract<ImplementStageOutcome, { kind: "succeeded" }> {
  if (outcome.kind !== "succeeded") {
    throw new Error(
      `expected a succeeded IMPLEMENT outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailed(
  outcome: ImplementStageOutcome,
): asserts outcome is Extract<ImplementStageOutcome, { kind: "failed" }> {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed IMPLEMENT outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
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

describe("executeImplementStage (M054a)", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m054a-"));
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

  async function implementOptions(
    overrides: Partial<ImplementStageOptions> = {},
  ): Promise<ImplementStageOptions> {
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

  it("invokes the agent to perform implementation and reports the changed paths", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
    );

    const outcome = await executeImplementStage(await implementOptions());

    expectSucceeded(outcome);
    expect(agent.invocations).toHaveLength(1);
    expect(agent.invocations[0]?.instruction).toBe(IMPLEMENT_STAGE_INSTRUCTION);
    expect(agent.invocations[0]?.worktreePath).toBe(worktreePath);
    expect(outcome.changedPaths).toEqual(["src/"]);
    expect(outcome.stageRun.id).toBe(implementStageRunId(attemptId));
    expect(outcome.stageRun.stage).toBe("IMPLEMENT");
    expect(outcome.stageRun.status).toBe("SUCCEEDED");
    expect(outcome.stageRun.output?.stdout).toBe("wrote src/utils.ts");
  });

  it("persists the RUNNING StageRun before the agent invocation", async () => {
    let sawRunningStageRun = false;
    agent = new FakeAgentRuntime(async (invocation) => {
      const stageRuns = await store.listStageRuns(attemptId);
      sawRunningStageRun = stageRuns.some(
        (run) =>
          run.id === implementStageRunId(attemptId) && run.status === "RUNNING",
      );
      writeChangeAt(invocation.worktreePath, "src/utils.ts", "fixed content\n");
      return {
        kind: "success",
        output: { stdout: "done", stderr: "" },
        exitCode: 0,
        durationMs: 5,
      };
    });

    const outcome = await executeImplementStage(await implementOptions());

    expectSucceeded(outcome);
    expect(sawRunningStageRun).toBe(true);
  });

  it("persists durable stage output that survives a store reopen", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
    );

    const outcome = await executeImplementStage(await implementOptions());
    expectSucceeded(outcome);

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      const durableRuns = await reopened.listStageRuns(attemptId);
      const implementRun = durableRuns.find(
        (run) => run.stage === "IMPLEMENT",
      );
      expect(implementRun?.status).toBe("SUCCEEDED");
      expect(implementRun?.output?.stdout).toBe("wrote src/utils.ts");
      expect(implementRun?.startedAt).toBe(FIXED_CLOCK);
      expect(implementRun?.finishedAt).toBe(FIXED_CLOCK);
    } finally {
      await reopened.close();
    }
  });

  it("leaves the implementation changes unstaged for the runner to own Git", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
    );

    const outcome = await executeImplementStage(await implementOptions());

    expectSucceeded(outcome);
    const status = await git.status(worktreePath);
    expect(status.clean).toBe(false);
    expect(status.entries[0]?.indexStatus).toBe("?");
    expect(status.entries[0]?.worktreeStatus).toBe("?");
  });

  it("supplies approved PLAN guidance to the implementation agent through the context pack", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
    );

    await executeImplementStage(
      await implementOptions({ guidance: { plan: PLAN_TEXT } }),
    );

    const invocation = agent.invocations[0];
    const planDocument = invocation?.contextPack.documents.find(
      (document) => document.path === "PLAN",
    );
    expect(planDocument?.content).toBe(PLAN_TEXT);
    expect(
      invocation?.contextPack.documents.some(
        (document) => document.path === "REVIEW_FEEDBACK",
      ),
    ).toBe(false);
  });

  it("supplies review/fix feedback from a prior cycle through the context pack", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const validatedAdd = (a: number, b: number): number => a + b;\n",
      }),
    );

    await executeImplementStage(
      await implementOptions({
        guidance: { reviewFeedback: REVIEW_FEEDBACK },
      }),
    );

    const invocation = agent.invocations[0];
    const feedbackDocument = invocation?.contextPack.documents.find(
      (document) => document.path === "REVIEW_FEEDBACK",
    );
    expect(feedbackDocument?.content).toBe(REVIEW_FEEDBACK);
    expect(
      invocation?.contextPack.documents.some(
        (document) => document.path === "PLAN",
      ),
    ).toBe(false);
  });

  it("supplies both plan and review feedback guidance when provided", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const validatedAdd = (a: number, b: number): number => a + b;\n",
      }),
    );

    await executeImplementStage(
      await implementOptions({
        guidance: { plan: PLAN_TEXT, reviewFeedback: REVIEW_FEEDBACK },
      }),
    );

    const documents = agent.invocations[0]?.contextPack.documents ?? [];
    expect(
      documents.find((document) => document.path === "PLAN")?.content,
    ).toBe(PLAN_TEXT);
    expect(
      documents.find((document) => document.path === "REVIEW_FEEDBACK")
        ?.content,
    ).toBe(REVIEW_FEEDBACK);
  });

  it("works without optional guidance and adds no extra context documents", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
    );

    const outcome = await executeImplementStage(await implementOptions());

    expectSucceeded(outcome);
    expect(agent.invocations[0]?.contextPack.documents).toEqual([]);
  });

  it("fails the stage when the agent fails, preserving normalized agent output", async () => {
    agent = new FakeAgentRuntime(agentFails("agent process crashed"));

    const outcome = await executeImplementStage(await implementOptions());

    expectFailed(outcome);
    expect(outcome.reason).toBe("agent failed: agent process crashed");
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.failure).toEqual({
      kind: "error",
      message: "agent failed: agent process crashed",
    });
    expect(outcome.stageRun.output?.stdout).toBe("partial output");
    expect(outcome.stageRun.output?.stderr).toBe("agent process crashed");
  });

  it("records a TIMED_OUT stage run when the agent invocation times out", async () => {
    agent = new FakeAgentRuntime(agentTimesOut());

    const outcome = await executeImplementStage(await implementOptions());

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("TIMED_OUT");
    expect(outcome.stageRun.failure).toEqual({
      kind: "timeout",
      message: "agent invocation timed out after 5000 ms",
    });
    expect(outcome.stageRun.output?.stdout).toBe("still running");
  });

  it("records a CANCELLED stage run when the agent invocation is cancelled", async () => {
    agent = new FakeAgentRuntime(agentIsCancelled());

    const outcome = await executeImplementStage(await implementOptions());

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(outcome.stageRun.failure).toEqual({
      kind: "cancelled",
      message: "agent invocation was cancelled",
    });
  });

  it("cancels before the agent invocation when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await executeImplementStage(
      await implementOptions({ signal: controller.signal }),
    );

    expectFailed(outcome);
    expect(outcome.stageRun.status).toBe("CANCELLED");
    expect(agent.invocations).toHaveLength(0);
  });

  it("fails the stage when the agent produced no usable code changes", async () => {
    agent = new FakeAgentRuntime(() => ({
      kind: "success",
      output: { stdout: "nothing to do", stderr: "" },
      exitCode: 0,
      durationMs: 5,
    }));

    const outcome = await executeImplementStage(await implementOptions());

    expectFailed(outcome);
    expect(outcome.reason).toBe(
      "agent produced no usable code changes: the task worktree is clean",
    );
    expect(outcome.stageRun.status).toBe("FAILED");
    expect(outcome.stageRun.output?.stdout).toBe("nothing to do");
  });

  it("leaves the task's authoritative state unchanged", async () => {
    agent = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
    );

    const outcome = await executeImplementStage(await implementOptions());

    expectSucceeded(outcome);
    expect((await storedTask()).status).toBe("READY");
    expect((await storedAttempt()).status).toBe("RUNNING");
    expect(await store.listEvents()).toHaveLength(0);
  });

  it("is provider-independent: the same behavior holds for any selected runtime", async () => {
    const first = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
      { id: "codex-cli" },
    );
    const second = new FakeAgentRuntime(
      agentAppliesChange({
        path: "src/utils.ts",
        content: "export const add = (a: number, b: number): number => a + b;\n",
      }),
      { id: "opencode", model: "fake-model" },
    );

    const firstOutcome = await executeImplementStage(
      await implementOptions({ agent: first }),
    );
    const secondOutcome = await executeImplementStage(
      await implementOptions({ agent: second }),
    );

    expectSucceeded(firstOutcome);
    expectSucceeded(secondOutcome);
    expect(firstOutcome.kind).toBe(secondOutcome.kind);
    expect(firstOutcome.changedPaths).toEqual(secondOutcome.changedPaths);
    expect(firstOutcome.stageRun.status).toBe(secondOutcome.stageRun.status);
    expect(first.invocations[0]?.agent.id).toBe("codex-cli");
    expect(second.invocations[0]?.agent.id).toBe("opencode");
    expect(second.invocations[0]?.agent.model).toBe("fake-model");
    expect(first.invocations[0]?.instruction).toBe(
      second.invocations[0]?.instruction,
    );
  });
});
