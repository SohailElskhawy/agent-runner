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
import { createGitManager, GitError } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore, StoredEvent } from "@agentic-dev-runner/persistence";
import type { StageRun, Task } from "@agentic-dev-runner/core";
import { resolveWorkflow } from "@agentic-dev-runner/core";
import { createWorkflowTaskExecutor } from "../src/workflow-executor.js";
import { ORCHESTRATION_EVENTS } from "../src/orchestration-events.js";
import type { TaskTransitionedPayload } from "../src/orchestration-events.js";
import type {
  CompletedTaskRun,
  FailedTaskRun,
  SingleTaskRunOutcome,
} from "../src/orchestration-outcome.js";
import type {
  AgentBehavior,
  VerificationResponse,
} from "./fixtures.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  FakeAgentRuntime,
  FakeVerificationEngine,
  failedVerificationRun,
  injectGitFailures,
  passedVerificationRun,
  runFixtureGit,
} from "./fixtures.js";

const taskId = "M001";
const change = {
  path: "src/utils.ts",
  content: "export const add = (a: number, b: number): number => a + b;\n",
};

const PLAN_MARKER = "STAGE PLAN — planning only";
const PLAN_REVIEW_MARKER = "STAGE PLAN_REVIEW — review only";
const IMPLEMENT_MARKER = "STAGE IMPLEMENT —";
const CODE_REVIEW_MARKER = "STAGE CODE_REVIEW —";

let directory: string;
let repoPath: string;
let worktreesDir: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let agent: FakeAgentRuntime;
let verification: FakeVerificationEngine;

type WireOptions = {
  readonly agent?: AgentBehavior | undefined;
  readonly verification?: VerificationResponse | undefined;
  readonly gitFailures?: Partial<Record<string, () => Error>> | undefined;
  readonly workflowId?: string | undefined;
};

function wireExecutor(options: WireOptions = {}) {
  agent = new FakeAgentRuntime(options.agent);
  verification = new FakeVerificationEngine(
    options.verification ?? ((input) => passedVerificationRun(input)),
  );
  const effectiveGit =
    options.gitFailures === undefined
      ? git
      : injectGitFailures(git, options.gitFailures);
  const task = createTask({ id: taskId, status: "READY" });
  const workflowId = options.workflowId ?? task.workflow;
  const resolution = resolveWorkflow(workflowId);
  if (!resolution.resolved) {
    throw new Error(`fixture workflow "${workflowId}" did not resolve`);
  }
  return createWorkflowTaskExecutor({
    store,
    git: effectiveGit,
    agent,
    verification,
    verificationChecks: [
      { name: "typecheck", executable: "node", args: ["--version"] },
      { name: "unit", executable: "node", args: ["--version"] },
    ],
    task,
    workflow: resolution.workflow,
    projectRoot: repoPath,
    worktreesDir,
    agentTimeoutMs: 5_000,
  });
}

function gitFailure(operation: string): () => Error {
  return () =>
    new GitError(`Git operation "${operation}" failed (injected failure)`, {
      operation,
      command: ["git", operation],
      exitCode: 128,
      reason: "injected failure",
      stdout: "",
      stderr: "injected failure",
    });
}

function agentImplements(changeToApply: {
  readonly path: string;
  readonly content: string;
}): AgentBehavior {
  return (invocation) => {
    const target = join(invocation.worktreePath, changeToApply.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, changeToApply.content);
    return {
      kind: "success",
      output: { stdout: `wrote ${changeToApply.path}`, stderr: "" },
      exitCode: 0,
      durationMs: 5,
    };
  };
}

function agentReplies(stdout: string): AgentBehavior {
  return () => ({
    kind: "success",
    output: { stdout, stderr: "" },
    exitCode: 0,
    durationMs: 5,
  });
}

const approvedReview = agentReplies('{"decision":"APPROVED"}');

function planAgent(): AgentBehavior {
  return agentReplies("# Plan\n\n1. Implement the utility function.\n");
}

function stageDispatchAgent(script: {
  readonly plan?: AgentBehavior | undefined;
  readonly planReview?: AgentBehavior | undefined;
  readonly implement?: AgentBehavior | undefined;
  readonly codeReview?: AgentBehavior | undefined;
}): AgentBehavior {
  return (invocation) => {
    const instruction = invocation.instruction ?? "";
    if (instruction.startsWith(PLAN_REVIEW_MARKER)) {
      return (script.planReview ?? approvedReview)(invocation);
    }
    if (instruction.startsWith(PLAN_MARKER)) {
      return (script.plan ?? planAgent())(invocation);
    }
    if (instruction.startsWith(CODE_REVIEW_MARKER)) {
      return (script.codeReview ?? approvedReview)(invocation);
    }
    if (instruction.startsWith(IMPLEMENT_MARKER)) {
      return (script.implement ?? agentImplements(change))(invocation);
    }
    throw new Error(
      `unexpected agent invocation without a stage instruction: ${JSON.stringify(instruction)}`,
    );
  };
}

function expectCompleted(
  outcome: SingleTaskRunOutcome,
): asserts outcome is CompletedTaskRun {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailed(
  outcome: SingleTaskRunOutcome,
): asserts outcome is FailedTaskRun {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

async function storedTask(): Promise<Task> {
  const task = await store.getTask(taskId);
  if (task === null) {
    throw new Error(`task "${taskId}" not found in store`);
  }
  return task;
}

function transitionPayloads(
  events: readonly StoredEvent[],
): readonly (readonly [string, string])[] {
  return events
    .filter((event) => event.type === ORCHESTRATION_EVENTS.taskTransitioned)
    .map((event) => event.payload as TaskTransitionedPayload)
    .map((payload) => [payload.from, payload.to] as const);
}

function eventsOfType(
  events: readonly StoredEvent[],
  type: string,
): readonly StoredEvent[] {
  return events.filter((event) => event.type === type);
}

describe("WorkflowTaskExecutor", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m051b-"));
    repoPath = join(directory, "project repo");
    worktreesDir = join(directory, "worktrees");
    dbPath = join(directory, "state.db");
    runner = createNodeProcessRunner();
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    git = createGitManager({ runner });
    await createFixtureRepository({
      runner,
      repositoryPath: repoPath,
      agentsMarkdown: AGENTS_MARKDOWN,
    });
    await store.putProject(createProject({ rootPath: repoPath }));
    await store.putTask(createTask({ id: taskId, status: "READY" }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("runs the default workflow end-to-end and persists DONE only after successful integration", async () => {
    const executor = wireExecutor({ agent: stageDispatchAgent({}) });

    const outcome = await executor.run();

    expectCompleted(outcome);
    expect(outcome.task.status).toBe("DONE");
    expect(outcome.attempt.status).toBe("SUCCEEDED");
    expect(outcome.integration.kind).toBe("fast-forward");
    expect(outcome.cleanup).toEqual({ kind: "removed" });
    expect(existsSync(outcome.worktreePath)).toBe(false);

    const attempts = await store.listAttempts({ taskId });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("SUCCEEDED");

    const stageRuns = await store.listStageRuns(outcome.attemptId);
    expect(stageRuns.map((run) => run.stage)).toEqual([
      "PLAN",
      "PLAN_REVIEW",
      "IMPLEMENT",
      "CODE_REVIEW",
      "VERIFY",
      "INTEGRATE",
    ]);
    for (const run of stageRuns) {
      expect(run.status).toBe("SUCCEEDED");
    }

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "IMPLEMENTING"],
      ["IMPLEMENTING", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.implementationCompleted)).toHaveLength(1);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.verificationCompleted)).toHaveLength(1);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.commitCreated)).toHaveLength(1);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.integrationCompleted)).toHaveLength(1);

    expect(verification.runs).toHaveLength(1);
    expect(verification.runs[0]?.cwd).toBe(outcome.worktreePath);

    const head = (await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD"])).trim();
    expect(outcome.integration.revision).toBe(head);
  });

  it("executes a workflow without PLAN/PLAN_REVIEW stages when the definition omits them", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      workflowId: "simple",
    });

    const outcome = await executor.run();

    expectCompleted(outcome);
    expect(outcome.task.status).toBe("DONE");

    const stageRuns = await store.listStageRuns(outcome.attemptId);
    expect(stageRuns.map((run) => run.stage)).toEqual([
      "IMPLEMENT",
      "VERIFY",
      "INTEGRATE",
    ]);

    const planInvocations = agent.invocations.filter(
      (invocation) =>
        (invocation.instruction ?? "").startsWith(PLAN_MARKER) ||
        (invocation.instruction ?? "").startsWith(PLAN_REVIEW_MARKER),
    );
    expect(planInvocations).toHaveLength(0);
  });

  it("does not run IMPLEMENT when the plan review-cycle budget is exhausted", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({
        planReview: agentReplies(
          '{"decision":"CHANGES_REQUIRED","feedback":"tighten the plan"}',
        ),
      }),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("plan review-cycle budget exhausted");
    expect(outcome.reason).toContain("tighten the plan");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("error");

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    expect(stageRuns.map((run) => run.stage)).toEqual([
      "PLAN",
      "PLAN_REVIEW",
      "PLAN",
      "PLAN_REVIEW",
    ]);
    expect(
      stageRuns.filter((run) => run.stage === "PLAN").map((run) => run.id),
    ).toEqual([
      `stage_${outcome.attempt.id}_PLAN`,
      `stage_${outcome.attempt.id}_PLAN_c2`,
    ]);

    const implementInvocations = agent.invocations.filter(
      (invocation) => (invocation.instruction ?? "").startsWith(IMPLEMENT_MARKER),
    );
    expect(implementInvocations).toHaveLength(0);
    expect(verification.runs).toHaveLength(0);

    const events = await store.listEvents({ taskId });
    const transitions = transitionPayloads(events);
    expect(transitions).not.toContainEqual(["IMPLEMENTING", "VERIFYING"]);
  });

  it("does not run VERIFY when the code review-cycle budget is exhausted", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({
        codeReview: agentReplies(
          '{"decision":"CHANGES_REQUIRED","feedback":"fix the boundary case"}',
        ),
      }),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("code review-cycle budget exhausted");
    expect(outcome.reason).toContain("fix the boundary case");
    expect(outcome.task.status).toBe("FAILED");

    const codeReviewRuns = (
      await store.listStageRuns(outcome.attempt.id)
    ).filter((run) => run.stage === "CODE_REVIEW");
    expect(codeReviewRuns).toHaveLength(2);
    expect(verification.runs).toHaveLength(0);

    const events = await store.listEvents({ taskId });
    const transitions = transitionPayloads(events);
    expect(transitions).not.toContainEqual(["IMPLEMENTING", "VERIFYING"]);
    expect(transitions).not.toContainEqual(["VERIFYING", "INTEGRATING"]);
  });

  it("does not integrate when worktree verification fails", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      verification: (input) =>
        failedVerificationRun(input, "unit", "unit tests failed"),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("verification failed");
    expect(outcome.reason).toContain("unit tests failed");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("verification_failed");

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    const verifyRun = stageRuns.find((run) => run.stage === "VERIFY");
    expect(verifyRun?.status).toBe("FAILED");

    const events = await store.listEvents({ taskId });
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.commitCreated)).toHaveLength(0);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.integrationCompleted)).toHaveLength(0);
    const transitions = transitionPayloads(events);
    expect(transitions).not.toContainEqual(["VERIFYING", "INTEGRATING"]);
  });

  it("does not mark DONE when integration fails", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      gitFailures: { integrateBranch: gitFailure("integrateBranch") },
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("integration failed");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("error");

    const events = await store.listEvents({ taskId });
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.integrationCompleted)).toHaveLength(0);
    const transitions = transitionPayloads(events);
    expect(transitions).not.toContainEqual(["INTEGRATING", "DONE"]);

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    const integrateRun = stageRuns.find((run) => run.stage === "INTEGRATE");
    expect(integrateRun?.status).toBe("FAILED");
  });

  it("records every authoritative status transition in workflow order", async () => {
    const executor = wireExecutor({ agent: stageDispatchAgent({}) });

    const outcome = await executor.run();

    expectCompleted(outcome);
    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "IMPLEMENTING"],
      ["IMPLEMENTING", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
    const finalTask = await storedTask();
    expect(finalTask.status).toBe("DONE");
    expect(outcome.task.id).toBe(taskId);
  });

  it("executes stage runs in the resolved workflow order without skipping required gates", async () => {
    const executor = wireExecutor({ agent: stageDispatchAgent({}) });

    const outcome = await executor.run();

    expectCompleted(outcome);
    const stageRuns: StageRun[] = await store.listStageRuns(outcome.attemptId);
    expect(stageRuns.map((run) => run.stage)).toEqual([
      "PLAN",
      "PLAN_REVIEW",
      "IMPLEMENT",
      "CODE_REVIEW",
      "VERIFY",
      "INTEGRATE",
    ]);
    const planReviewRun = stageRuns.find((run) => run.stage === "PLAN_REVIEW");
    expect(planReviewRun?.output?.planReview?.decision).toBe("APPROVED");
    const verifyRun = stageRuns.find((run) => run.stage === "VERIFY");
    expect(verifyRun?.status).toBe("SUCCEEDED");
    expect(verification.runs).toHaveLength(1);
  });
});
