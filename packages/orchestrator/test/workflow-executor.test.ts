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
import type { StageRun, Task, WorkflowDefinition } from "@agentic-dev-runner/core";
import { resolveWorkflow } from "@agentic-dev-runner/core";
import { createWorkflowTaskExecutor } from "../src/workflow-executor.js";
import { ORCHESTRATION_EVENTS } from "../src/orchestration-events.js";
import type {
  IntegrationVerificationCompletedPayload,
  TaskTransitionedPayload,
} from "../src/orchestration-events.js";
import type {
  CancelledTaskRun,
  CompletedTaskRun,
  FailedTaskRun,
} from "../src/orchestration-outcome.js";
import type {
  BlockedTaskRun,
  WorkflowTaskRunOutcome,
} from "../src/workflow-outcome.js";
import type { RejectedTaskRun } from "../src/orchestration-outcome.js";
import type {
  AgentBehavior,
  VerificationResponse,
} from "./fixtures.js";
import {
  AGENTS_MARKDOWN,
  agentFails,
  agentIsCancelled,
  agentTimesOut,
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
  readonly gitOverride?: GitManager | undefined;
  readonly workflowId?: string | undefined;
  readonly workflowOverride?: WorkflowDefinition | undefined;
};

function wireExecutor(options: WireOptions = {}) {
  agent = new FakeAgentRuntime(options.agent);
  verification = new FakeVerificationEngine(
    options.verification ?? ((input) => passedVerificationRun(input)),
  );
  const failureInjectedGit =
    options.gitFailures === undefined
      ? git
      : injectGitFailures(git, options.gitFailures);
  const effectiveGit = options.gitOverride ?? failureInjectedGit;
  const task = createTask({ id: taskId, status: "READY" });
  const resolution = resolveWorkflow(options.workflowId ?? task.workflow);
  if (!resolution.resolved) {
    throw new Error(`fixture workflow "${options.workflowId ?? task.workflow}" did not resolve`);
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
    workflow: options.workflowOverride ?? resolution.workflow,
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
  outcome: WorkflowTaskRunOutcome,
): asserts outcome is CompletedTaskRun {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectFailed(
  outcome: WorkflowTaskRunOutcome,
): asserts outcome is FailedTaskRun {
  if (outcome.kind !== "failed") {
    throw new Error(
      `expected a failed outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectBlocked(
  outcome: WorkflowTaskRunOutcome,
): asserts outcome is BlockedTaskRun {
  if (outcome.kind !== "blocked") {
    throw new Error(
      `expected a blocked outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectCancelled(
  outcome: WorkflowTaskRunOutcome,
): asserts outcome is CancelledTaskRun {
  if (outcome.kind !== "cancelled") {
    throw new Error(
      `expected a cancelled outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectRejected(
  outcome: WorkflowTaskRunOutcome,
): asserts outcome is RejectedTaskRun {
  if (outcome.kind !== "rejected") {
    throw new Error(
      `expected a rejected outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
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
      ["READY", "PLANNING"],
      ["PLANNING", "PLAN_REVIEW"],
      ["PLAN_REVIEW", "IMPLEMENTING"],
      ["IMPLEMENTING", "CODE_REVIEW"],
      ["CODE_REVIEW", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.implementationCompleted)).toHaveLength(1);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.verificationCompleted)).toHaveLength(1);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.commitCreated)).toHaveLength(1);
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.integrationCompleted)).toHaveLength(1);

    expect(verification.runs).toHaveLength(2);
    expect(verification.runs[0]?.cwd).toBe(outcome.worktreePath);
    expect(verification.runs[1]?.cwd).toBe(repoPath);
    expect(verification.runs[1]?.checks.map((check) => check.name)).toEqual([
      "typecheck",
      "unit",
    ]);

    const integrationVerificationEvents = eventsOfType(
      events,
      ORCHESTRATION_EVENTS.integrationVerificationCompleted,
    );
    expect(integrationVerificationEvents).toHaveLength(1);
    const integrationVerificationPayload = integrationVerificationEvents[0]
      ?.payload as IntegrationVerificationCompletedPayload;
    expect(integrationVerificationPayload?.revision).toBe(outcome.integration.revision);
    expect(integrationVerificationPayload?.status).toBe("PASSED");
    expect(integrationVerificationPayload?.checks).toHaveLength(2);

    const head = (await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD"])).trim();
    expect(outcome.integration.revision).toBe(head);
  });

  it("executes a workflow without PLAN/PLAN_REVIEW stages when the definition omits them", async () => {    const executor = wireExecutor({
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

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "IMPLEMENTING"],
      ["IMPLEMENTING", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
  });

  it("transitions PLANNING directly into IMPLEMENTING when the workflow has PLAN without PLAN_REVIEW", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      workflowOverride: {
        id: "plan-without-review",
        stages: ["PLAN", "IMPLEMENT", "VERIFY", "INTEGRATE"],
      },
    });

    const outcome = await executor.run();

    expectCompleted(outcome);
    expect(outcome.task.status).toBe("DONE");

    const stageRuns = await store.listStageRuns(outcome.attemptId);
    expect(stageRuns.map((run) => run.stage)).toEqual([
      "PLAN",
      "IMPLEMENT",
      "VERIFY",
      "INTEGRATE",
    ]);

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "PLANNING"],
      ["PLANNING", "IMPLEMENTING"],
      ["IMPLEMENTING", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
  });

  it("runs the canonical PLAN review fix cycle through legal status transitions", async () => {
    let planReviewCalls = 0;
    const executor = wireExecutor({
      agent: stageDispatchAgent({
        planReview: () => {
          planReviewCalls += 1;
          return planReviewCalls === 1
            ? {
                kind: "success" as const,
                output: {
                  stdout:
                    '{"decision":"CHANGES_REQUIRED","feedback":"tighten the plan"}',
                  stderr: "",
                },
                exitCode: 0,
                durationMs: 5,
              }
            : {
                kind: "success" as const,
                output: { stdout: '{"decision":"APPROVED"}', stderr: "" },
                exitCode: 0,
                durationMs: 5,
              };
        },
      }),
    });

    const outcome = await executor.run();

    expectCompleted(outcome);
    expect(outcome.task.status).toBe("DONE");
    expect(planReviewCalls).toBe(2);

    const stageRuns = await store.listStageRuns(outcome.attemptId);
    expect(stageRuns.filter((run) => run.stage === "PLAN")).toHaveLength(2);
    expect(stageRuns.filter((run) => run.stage === "PLAN_REVIEW")).toHaveLength(2);

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "PLANNING"],
      ["PLANNING", "PLAN_REVIEW"],
      ["PLAN_REVIEW", "PLANNING"],
      ["PLANNING", "PLAN_REVIEW"],
      ["PLAN_REVIEW", "IMPLEMENTING"],
      ["IMPLEMENTING", "CODE_REVIEW"],
      ["CODE_REVIEW", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
  });

  it("runs the canonical CODE review fix cycle through legal status transitions", async () => {
    let codeReviewCalls = 0;
    const executor = wireExecutor({
      agent: stageDispatchAgent({
        codeReview: () => {
          codeReviewCalls += 1;
          return codeReviewCalls === 1
            ? {
                kind: "success" as const,
                output: {
                  stdout:
                    '{"decision":"CHANGES_REQUIRED","feedback":"fix the boundary case"}',
                  stderr: "",
                },
                exitCode: 0,
                durationMs: 5,
              }
            : {
                kind: "success" as const,
                output: { stdout: '{"decision":"APPROVED"}', stderr: "" },
                exitCode: 0,
                durationMs: 5,
              };
        },
      }),
    });

    const outcome = await executor.run();

    expectCompleted(outcome);
    expect(outcome.task.status).toBe("DONE");
    expect(codeReviewCalls).toBe(2);

    const stageRuns = await store.listStageRuns(outcome.attemptId);
    expect(stageRuns.filter((run) => run.stage === "IMPLEMENT")).toHaveLength(2);
    expect(stageRuns.filter((run) => run.stage === "CODE_REVIEW")).toHaveLength(2);

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "PLANNING"],
      ["PLANNING", "PLAN_REVIEW"],
      ["PLAN_REVIEW", "IMPLEMENTING"],
      ["IMPLEMENTING", "CODE_REVIEW"],
      ["CODE_REVIEW", "IMPLEMENTING"],
      ["IMPLEMENTING", "CODE_REVIEW"],
      ["CODE_REVIEW", "VERIFYING"],
      ["VERIFYING", "INTEGRATING"],
      ["INTEGRATING", "DONE"],
    ]);
  });

  it("blocks the task and does not run IMPLEMENT when the plan review-cycle budget is exhausted", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({
        planReview: agentReplies(
          '{"decision":"CHANGES_REQUIRED","feedback":"tighten the plan"}',
        ),
      }),
    });

    const outcome = await executor.run();

    expectBlocked(outcome);
    expect(outcome.reason).toContain("plan review-cycle budget exhausted");
    expect(outcome.reason).toContain("tighten the plan");
    expect(outcome.task.status).toBe("BLOCKED");
    expect(outcome.attempt.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("error");
    expect(outcome.attempt.failure?.message).toContain(
      "plan review-cycle budget exhausted",
    );

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    expect(stageRuns.map((run) => run.stage)).toEqual([
      "PLAN",
      "PLAN_REVIEW",
      "PLAN",
      "PLAN_REVIEW",
    ]);
    const exhaustedReviewRuns = stageRuns.filter(
      (run) => run.stage === "PLAN_REVIEW",
    );
    for (const reviewRun of exhaustedReviewRuns) {
      expect(reviewRun.status).toBe("SUCCEEDED");
      expect(reviewRun.output?.planReview?.decision).toBe("CHANGES_REQUIRED");
    }

    const implementInvocations = agent.invocations.filter(
      (invocation) => (invocation.instruction ?? "").startsWith(IMPLEMENT_MARKER),
    );
    expect(implementInvocations).toHaveLength(0);
    expect(verification.runs).toHaveLength(0);

    const events = await store.listEvents({ taskId });
    const transitions = transitionPayloads(events);
    expect(transitions).toContainEqual(["PLAN_REVIEW", "BLOCKED"]);
    expect(transitions).not.toContainEqual(["PLAN_REVIEW", "VERIFYING"]);
    expect(transitions).not.toContainEqual(["INTEGRATING", "DONE"]);
    const failedEvent = events.find(
      (event) =>
        event.type === ORCHESTRATION_EVENTS.taskTransitioned &&
        (event.payload as TaskTransitionedPayload).to === "BLOCKED",
    );
    const failurePayload = failedEvent?.payload as TaskTransitionedPayload;
    expect(failurePayload?.failure?.message).toContain(
      "plan review-cycle budget exhausted",
    );
  });

  it("blocks the task and does not run VERIFY when the code review-cycle budget is exhausted", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({
        codeReview: agentReplies(
          '{"decision":"CHANGES_REQUIRED","feedback":"fix the boundary case"}',
        ),
      }),
    });

    const outcome = await executor.run();

    expectBlocked(outcome);
    expect(outcome.reason).toContain("code review-cycle budget exhausted");
    expect(outcome.reason).toContain("fix the boundary case");
    expect(outcome.task.status).toBe("BLOCKED");

    const codeReviewRuns = (
      await store.listStageRuns(outcome.attempt.id)
    ).filter((run) => run.stage === "CODE_REVIEW");
    expect(codeReviewRuns).toHaveLength(2);
    expect(verification.runs).toHaveLength(0);

    const events = await store.listEvents({ taskId });
    const transitions = transitionPayloads(events);
    expect(transitions).toContainEqual(["CODE_REVIEW", "BLOCKED"]);
    expect(transitions).not.toContainEqual(["CODE_REVIEW", "VERIFYING"]);
    expect(transitions).not.toContainEqual(["VERIFYING", "INTEGRATING"]);
    expect(transitions).not.toContainEqual(["INTEGRATING", "DONE"]);
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

  it("does not mark DONE when integration verification fails even though the worktree verification passed", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      verification: (input) =>
        input.cwd === repoPath
          ? failedVerificationRun(input, "typecheck", "integrated typecheck failed")
          : passedVerificationRun(input),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("integration verification failed");
    expect(outcome.reason).toContain("integrated typecheck failed");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("verification_failed");

    const events = await store.listEvents({ taskId });
    expect(
      eventsOfType(events, ORCHESTRATION_EVENTS.integrationCompleted),
    ).toHaveLength(1);
    const integrationVerificationEvents = eventsOfType(
      events,
      ORCHESTRATION_EVENTS.integrationVerificationCompleted,
    );
    expect(integrationVerificationEvents).toHaveLength(1);
    const payload = integrationVerificationEvents[0]
      ?.payload as IntegrationVerificationCompletedPayload;
    expect(payload?.status).toBe("FAILED");
    const transitions = transitionPayloads(events);
    expect(transitions).not.toContainEqual(["INTEGRATING", "DONE"]);

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    const integrateRun = stageRuns.find((run) => run.stage === "INTEGRATE");
    expect(integrateRun?.status).toBe("FAILED");
    expect(integrateRun?.failure?.message).toContain(
      "integration verification failed",
    );
    expect(verification.runs).toHaveLength(2);
  });

  it("integrates the attempt branch exactly once per workflow run", async () => {
    const integrateBranchCalls: string[] = [];
    const countingGit: GitManager = new Proxy(git, {
      get(target, property) {
        if (property === "integrateBranch") {
          return (cwd: string, branchName: string) => {
            integrateBranchCalls.push(branchName);
            return target.integrateBranch(cwd, branchName);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      gitOverride: countingGit,
    });

    const outcome = await executor.run();

    expectCompleted(outcome);
    expect(integrateBranchCalls).toEqual([`task/${taskId}/attempt-1`]);
    expect(outcome.integration.kind).toBe("fast-forward");
  });

  it("records every authoritative status transition in workflow order", async () => {
    const executor = wireExecutor({ agent: stageDispatchAgent({}) });

    const outcome = await executor.run();

    expectCompleted(outcome);
    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toEqual([
      ["READY", "PLANNING"],
      ["PLANNING", "PLAN_REVIEW"],
      ["PLAN_REVIEW", "IMPLEMENTING"],
      ["IMPLEMENTING", "CODE_REVIEW"],
      ["CODE_REVIEW", "VERIFYING"],
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
    expect(verification.runs).toHaveLength(2);
  });

  it("fails deterministically when the PLAN stage agent fails, preserving the stop reason", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({ plan: agentFails("planner crashed") }),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("agent failed: planner crashed");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("error");
    expect(outcome.attempt.failure?.message).toContain("planner crashed");

    const attempts = await store.listAttempts({ taskId });
    expect(attempts[0]?.failure?.message).toContain("planner crashed");
    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    const planRun = stageRuns.find((run) => run.stage === "PLAN");
    expect(planRun?.status).toBe("FAILED");
    expect(planRun?.failure?.message).toContain("planner crashed");

    const events = await store.listEvents({ taskId });
    const transitions = transitionPayloads(events);
    expect(transitions).toContainEqual(["PLANNING", "FAILED"]);
    expect(transitions).not.toContainEqual(["PLANNING", "VERIFYING"]);
    expect(transitions).not.toContainEqual(["INTEGRATING", "DONE"]);
  });

  it("fails deterministically when the IMPLEMENT stage agent fails", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({ implement: agentFails("implementer crashed") }),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("agent failed: implementer crashed");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.failure?.kind).toBe("error");

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    const planRuns = stageRuns.filter((run) => run.stage === "PLAN");
    for (const planRun of planRuns) {
      expect(planRun.status).toBe("SUCCEEDED");
    }
    const implementRun = stageRuns.find((run) => run.stage === "IMPLEMENT");
    expect(implementRun?.status).toBe("FAILED");
    expect(verification.runs).toHaveLength(0);

    const events = await store.listEvents({ taskId });
    const transitions = transitionPayloads(events);
    expect(transitions).not.toContainEqual(["IMPLEMENTING", "VERIFYING"]);
    expect(transitions).not.toContainEqual(["INTEGRATING", "DONE"]);
  });

  it("maps a timed-out stage onto a TIMED_OUT attempt and a FAILED task", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({ plan: agentTimesOut() }),
    });

    const outcome = await executor.run();

    expectFailed(outcome);
    expect(outcome.reason).toContain("timed out");
    expect(outcome.task.status).toBe("FAILED");
    expect(outcome.attempt.status).toBe("TIMED_OUT");
    expect(outcome.attempt.failure?.kind).toBe("timeout");

    const stageRuns = await store.listStageRuns(outcome.attempt.id);
    const planRun = stageRuns.find((run) => run.stage === "PLAN");
    expect(planRun?.status).toBe("TIMED_OUT");

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).not.toContainEqual([
      "INTEGRATING",
      "DONE",
    ]);
  });

  it("maps a cancelled stage onto a cancelled outcome without reaching DONE", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({ plan: agentIsCancelled() }),
    });

    const outcome = await executor.run();

    expectCancelled(outcome);
    expect(outcome.reason).toContain("cancelled");
    expect(outcome.task.status).toBe("CANCELLED");
    expect(outcome.attempt.status).toBe("CANCELLED");
    expect(outcome.attempt.failure?.kind).toBe("cancelled");

    const events = await store.listEvents({ taskId });
    expect(transitionPayloads(events)).toContainEqual([
      "PLANNING",
      "CANCELLED",
    ]);
    expect(transitionPayloads(events)).not.toContainEqual([
      "INTEGRATING",
      "DONE",
    ]);
  });

  it("rejects a workflow definition whose stage ordering violates the canonical lifecycle", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      workflowOverride: {
        id: "misordered",
        stages: ["IMPLEMENT", "VERIFY", "CODE_REVIEW", "INTEGRATE"],
      },
    });

    const outcome = await executor.run();

    expectRejected(outcome);
    expect(outcome.reason).toContain('workflow "misordered" is not executable');
    expect(agent.invocations).toHaveLength(0);
    expect(verification.runs).toHaveLength(0);
    const task = await storedTask();
    expect(task.status).toBe("READY");
  });

  it("rejects a workflow definition containing stages that are not lifecycle stages", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      workflowOverride: {
        id: "unknown-stages",
        stages: ["IMPLEMENT", "VERIFY", "INTEGRATE", "DEPLOY"] as unknown as WorkflowDefinition["stages"],
      },
    });

    const outcome = await executor.run();

    expectRejected(outcome);
    expect(outcome.reason).toContain("DEPLOY");
    expect(agent.invocations).toHaveLength(0);
    expect(verification.runs).toHaveLength(0);
  });

  it("rejects a workflow that requires PLAN_REVIEW without PLAN instead of executing a review that can never pass", async () => {
    const executor = wireExecutor({
      agent: stageDispatchAgent({}),
      workflowOverride: {
        id: "review-without-plan",
        stages: ["PLAN_REVIEW", "IMPLEMENT", "VERIFY", "INTEGRATE"],
      },
    });

    const outcome = await executor.run();

    expectRejected(outcome);
    expect(outcome.reason).toContain("PLAN_REVIEW without PLAN");
    expect(agent.invocations).toHaveLength(0);
    const events = await store.listEvents({ taskId });
    expect(eventsOfType(events, ORCHESTRATION_EVENTS.attemptStarted)).toHaveLength(0);
  });
});
