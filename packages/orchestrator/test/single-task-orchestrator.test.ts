import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager, GitError } from "@agentic-dev-runner/git";
import type { GitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { Attempt, Task } from "@agentic-dev-runner/core";
import {
  createSingleTaskOrchestrator,
  ORCHESTRATION_EVENTS,
  OrchestrationError,
} from "../src/index.js";
import type {
  CompletedTaskRun,
  CancelledTaskRun,
  FailedTaskRun,
  RejectedTaskRun,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
  TaskTransitionedPayload,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  agentAppliesChange,
  agentFails,
  agentIsCancelled,
  agentTimesOut,
  cancelledVerificationRun,
  createFixtureRepository,
  createProject,
  createTask,
  failedVerificationRun,
  FakeAgentRuntime,
  FakeVerificationEngine,
  injectGitFailures,
  passedVerificationRun,
  runFixtureGit,
  writeChangeAt,
} from "./fixtures.js";
import type { AgentBehavior, VerificationResponse } from "./fixtures.js";
import type { GitStatusEntry } from "@agentic-dev-runner/git";

const taskId = "M001";
const change = {
  path: "src/utils.ts",
  content: "export const add = (a: number, b: number): number => a + b;\n",
};

let directory: string;
let repoPath: string;
let worktreesDir: string;
let dbPath: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: GitManager;
let baseRevision: string;
let agent: FakeAgentRuntime;
let verification: FakeVerificationEngine;
let orchestrator: SingleTaskOrchestrator;

type WireOptions = {
  readonly agent?: AgentBehavior | undefined;
  readonly verification?: VerificationResponse | undefined;
  readonly gitFailures?: Partial<Record<string, () => Error>> | undefined;
  readonly projectRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

function wireOrchestrator(options: WireOptions = {}): void {
  agent = new FakeAgentRuntime(options.agent);
  verification = new FakeVerificationEngine(
    options.verification ?? ((input) => passedVerificationRun(input)),
  );
  const effectiveGit =
    options.gitFailures === undefined
      ? git
      : injectGitFailures(git, options.gitFailures);
  orchestrator = createSingleTaskOrchestrator({
    store,
    git: effectiveGit,
    agent,
    verification,
    verificationChecks: [
      { name: "typecheck", executable: "node", args: ["--version"] },
      { name: "unit", executable: "node", args: ["--version"] },
    ],
    projectRoot: options.projectRoot ?? repoPath,
    worktreesDir,
    agentTimeoutMs: 5_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function storedTask(id: string = taskId): Promise<Task> {
  const task = await store.getTask(id);
  if (task === null) {
    throw new Error(`task "${id}" not found in store`);
  }
  return task;
}

function storedAttempts(id: string = taskId): Promise<Attempt[]> {
  return store.listAttempts({ taskId: id });
}

function eventPayload(payload: unknown): TaskTransitionedPayload {
  return payload as TaskTransitionedPayload;
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

function withExtraStatusEntries(
  inner: GitManager,
  extra: readonly GitStatusEntry[],
): GitManager {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "status") {
        return (cwd: string) =>
          target.status(cwd).then((status) => ({
            ...status,
            entries: [...status.entries, ...extra],
          }));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedScopedTask(
  id: string,
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): Promise<void> {
  const base = createTask({ id, status: "READY" });
  await store.putTask({
    ...base,
    definition: {
      ...base.definition,
      scope: { allowedPaths, forbiddenPaths },
    },
  });
}

async function commitFixtureFile(
  relativePath: string,
  content: string,
): Promise<void> {
  writeChangeAt(repoPath, relativePath, content);
  await runFixtureGit(runner, repoPath, ["add", relativePath]);
  await runFixtureGit(runner, repoPath, ["commit", "-m", `fixture: ${relativePath}`]);
}

function agentRenamesViaGit(from: string, to: string): AgentBehavior {
  return (invocation) =>
    runFixtureGit(runner, invocation.worktreePath, ["mv", from, to]).then(() => ({
      kind: "success",
      output: { stdout: `moved ${from} to ${to}`, stderr: "" },
      exitCode: 0,
      durationMs: 5,
    }));
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

function expectCancelled(
  outcome: SingleTaskRunOutcome,
): asserts outcome is CancelledTaskRun {
  if (outcome.kind !== "cancelled") {
    throw new Error(
      `expected a cancelled outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

function expectRejected(
  outcome: SingleTaskRunOutcome,
): asserts outcome is RejectedTaskRun {
  if (outcome.kind !== "rejected") {
    throw new Error(
      `expected a rejected outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

describe("SingleTaskOrchestrator", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-vs011-"));
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
    await store.putTask(createTask({ id: taskId, status: "READY" }));
    wireOrchestrator();
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("runs one READY task end-to-end and persists DONE only after integration", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });

    const outcome = await orchestrator.run(taskId);

    expectCompleted(outcome);
    expect((await storedTask()).status).toBe("DONE");
    const integrationHead = await headRevision("HEAD");
    expect(outcome.integration).toEqual({
      kind: "fast-forward",
      revision: integrationHead,
    });
    expect(outcome.branch).toBe(`task/${taskId}/attempt-1`);
    expect(outcome.worktreePath).toBe(join(worktreesDir, taskId, "attempt-1"));
    expect(outcome.attemptId).toBe("att_M001_1");
    expect(outcome.cleanup).toEqual({ kind: "removed" });
    expect(existsSync(outcome.worktreePath)).toBe(false);
  });

  it("creates one attempt linked to the task with evidence", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });

    await orchestrator.run(taskId);

    const attempts = await storedAttempts();
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    expect(attempt?.id).toBe("att_M001_1");
    expect(attempt?.taskId).toBe(taskId);
    expect(attempt?.number).toBe(1);
    expect(attempt?.status).toBe("SUCCEEDED");
    expect(attempt?.agent).toBe("fake-agent");
    expect(attempt?.baseRevision).toBe(baseRevision);
    expect(attempt?.startedAt).toBeDefined();
    expect(attempt?.finishedAt).toBeDefined();
    expect(attempt?.failure).toBeUndefined();
    expect(attempt?.contextManifest?.entries.map((entry) => entry.kind)).toEqual([
      "task",
      "agents_md",
      "allowed_paths",
      "forbidden_paths",
      "base_revision",
    ]);
    expect(attempt?.logs?.stdout).toBe(`wrote ${change.path}`);
  });

  it("builds the ContextPack from the task worktree at the recorded base revision", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });

    await orchestrator.run(taskId);

    expect(agent.invocations).toHaveLength(1);
    const invocation = agent.invocations[0];
    expect(invocation?.worktreePath).toBe(join(worktreesDir, taskId, "attempt-1"));
    expect(invocation?.contextPack.task.id).toBe(taskId);
    expect(invocation?.contextPack.baseRevision).toBe(baseRevision);
    expect(invocation?.contextPack.agentsMarkdown).toBe(AGENTS_MARKDOWN);
    expect(invocation?.contextPack.agentsMarkdownPath).toBe("AGENTS.md");
    expect(
      invocation?.contextPack.manifest.entries.some(
        (entry) => entry.kind === "base_revision" && entry.digest !== undefined,
      ),
    ).toBe(true);
    expect(
      invocation?.contextPack.manifest.entries.some(
        (entry) => entry.kind === "agents_md" && entry.source === "AGENTS.md",
      ),
    ).toBe(true);
  });

  it("produces exactly one atomic task commit on top of the base revision", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });

    await orchestrator.run(taskId);

    const head = await headRevision("HEAD");
    expect(head).not.toBe(baseRevision);
    const parent = await runFixtureGit(runner, repoPath, ["rev-parse", "HEAD~1"]);
    expect(parent.trim()).toBe(baseRevision);
    const subject = await runFixtureGit(runner, repoPath, [
      "log",
      "--format=%s",
      "-1",
    ]);
    expect(subject.trim()).toBe(`task ${taskId}: Add a small utility function`);
    const branchHead = await headRevision(`task/${taskId}/attempt-1`);
    expect(branchHead).toBe(head);
  });

  it("records the full event sequence with VS003-conformant transitions", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });

    await orchestrator.run(taskId);

    const events = await store.listEvents({ taskId });
    expect(events.map((event) => event.type)).toEqual([
      "attempt.started",
      "task.transitioned",
      "worktree.created",
      "implementation.completed",
      "task.transitioned",
      "verification.completed",
      "commit.created",
      "task.transitioned",
      "integration.completed",
      "task.transitioned",
    ]);

    const transitions = events.filter(
      (event) => event.type === ORCHESTRATION_EVENTS.taskTransitioned,
    );
    expect(transitions.map((event) => eventPayload(event.payload).from)).toEqual([
      "READY",
      "IMPLEMENTING",
      "VERIFYING",
      "INTEGRATING",
    ]);
    expect(transitions.map((event) => eventPayload(event.payload).to)).toEqual([
      "IMPLEMENTING",
      "VERIFYING",
      "INTEGRATING",
      "DONE",
    ]);
    expect(
      transitions.map((event) => eventPayload(event.payload).attemptId),
    ).toEqual(["att_M001_1", "att_M001_1", "att_M001_1", "att_M001_1"]);

    const integrationIndex = events.findIndex(
      (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
    );
    const doneIndex = events.findIndex(
      (event) => eventPayload(event.payload).to === "DONE",
    );
    expect(integrationIndex).toBeGreaterThan(-1);
    expect(integrationIndex).toBeLessThan(doneIndex);

    const verificationEvent = events.find(
      (event) => event.type === ORCHESTRATION_EVENTS.verificationCompleted,
    );
    expect(verificationEvent?.payload).toMatchObject({ status: "PASSED" });

    const attemptEvent = events.find(
      (event) => event.type === ORCHESTRATION_EVENTS.attemptStarted,
    );
    expect(attemptEvent?.payload).toMatchObject({
      attemptId: "att_M001_1",
      attemptNumber: 1,
      agent: "fake-agent",
      baseRevision,
    });
  });

  it("persists task state, attempt evidence, and events across a store reopen", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });
    await orchestrator.run(taskId);
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();

      const task = await reopened.getTask(taskId);
      expect(task?.status).toBe("DONE");

      const attempts = await reopened.listAttempts({ taskId });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("SUCCEEDED");
      expect(attempts[0]?.contextManifest).toBeDefined();
      expect(attempts[0]?.logs?.stdout).toBe(`wrote ${change.path}`);

      const events = await reopened.listEvents({ taskId });
      expect(events.map((event) => event.type)).toContain(
        "integration.completed",
      );
      expect(events.map((event) => event.type)).toContain(
        "verification.completed",
      );
    } finally {
      await reopened.close();
    }
  });

  it("persists failure state across a store reopen", async () => {
    wireOrchestrator({
      agent: agentAppliesChange(change),
      verification: (input) =>
        failedVerificationRun(input, "typecheck", "typecheck exited with code 2"),
    });
    await orchestrator.run(taskId);
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();

      const task = await reopened.getTask(taskId);
      expect(task?.status).toBe("FAILED");

      const attempts = await reopened.listAttempts({ taskId });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("FAILED");
      expect(attempts[0]?.failure?.kind).toBe("verification_failed");
    } finally {
      await reopened.close();
    }
  });

  it("resolves required checks in the task-declared order regardless of configuration order", async () => {
    const base = createTask({ id: "M-ORDER", status: "READY" });
    await store.putTask({
      ...base,
      definition: {
        ...base.definition,
        verification: { required: ["unit", "typecheck"] },
      },
    });
    wireOrchestrator({ agent: agentAppliesChange(change) });

    const outcome = await orchestrator.run("M-ORDER");

    expectCompleted(outcome);
    expect(verification.runs).toHaveLength(1);
    const run = verification.runs[0];
    expect(run?.checks.map((check) => check.name)).toEqual([
      "unit",
      "typecheck",
    ]);
  });

  it("rejects required checks with no configured command before creating an attempt", async () => {
    const base = createTask({ id: "M-MISSING", status: "READY" });
    await store.putTask({
      ...base,
      definition: {
        ...base.definition,
        verification: { required: ["typecheck", "lint"] },
      },
    });
    wireOrchestrator({ agent: agentAppliesChange(change) });

    const outcome = await orchestrator.run("M-MISSING");

    expectRejected(outcome);
    expect(outcome.reason).toBe(
      "no verification command configured for required checks: lint",
    );
    expect(await store.listAttempts({ taskId: "M-MISSING" })).toHaveLength(0);
    expect((await store.getTask("M-MISSING"))?.status).toBe("READY");
    expect(verification.runs).toHaveLength(0);
  });

  it("rejects a task that is not READY without creating an attempt", async () => {
    const nonReadyStatuses = [
      "BACKLOG",
      "IMPLEMENTING",
      "VERIFYING",
      "INTEGRATING",
      "DONE",
      "FAILED",
      "CANCELLED",
    ] as const;

    for (const status of nonReadyStatuses) {
      const id = `M-${status}`;
      await store.putTask(createTask({ id, status }));

      const outcome = await orchestrator.run(id);

      expectRejected(outcome);
      expect(outcome.taskStatus).toBe(status);
      expect(outcome.reason).toContain(`status is "${status}"`);
      expect(await store.listAttempts({ taskId: id })).toHaveLength(0);
      expect((await store.getTask(id))?.status).toBe(status);
    }
  });

  it("rejects an unknown task", async () => {
    const outcome = await orchestrator.run("M-UNKNOWN");

    expectRejected(outcome);
    expect(outcome.reason).toContain("not found");
  });

  it("prevents verification, commit, integration, and DONE when the agent fails", async () => {
    wireOrchestrator({
      agent: (invocation) => {
        writeFileSync(join(invocation.worktreePath, "partial.txt"), "partial\n");
        return {
          kind: "failure",
          failure: { kind: "process", message: "agent process crashed" },
          output: { stdout: "partial", stderr: "crash" },
          durationMs: 5,
        };
      },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("agent failed");
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failure).toEqual({
      kind: "error",
      message: expect.stringContaining("agent failed"),
    });
    expect(verification.runs).toHaveLength(0);

    const branchHead = await headRevision(`task/${taskId}/attempt-1`);
    expect(branchHead).toBe(baseRevision);
    expect(await headRevision("HEAD")).toBe(baseRevision);
    expect(outcome.cleanup).toEqual({ kind: "skipped", reason: "dirty-worktree" });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(true);

    const events = await store.listEvents({ taskId });
    const last = events.at(-1);
    expect(last?.type).toBe(ORCHESTRATION_EVENTS.taskTransitioned);
    expect(eventPayload(last?.payload)).toMatchObject({
      from: "IMPLEMENTING",
      to: "FAILED",
      attemptId: "att_M001_1",
    });
    expect(eventPayload(last?.payload).failure).toMatchObject({ kind: "error" });
  });

  it("marks the attempt TIMED_OUT and the task FAILED when the agent times out", async () => {
    wireOrchestrator({ agent: agentTimesOut() });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("timed out");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("TIMED_OUT");
    expect(attempt?.failure).toMatchObject({ kind: "timeout" });
    expect((await storedTask()).status).toBe("FAILED");
    expect(verification.runs).toHaveLength(0);
  });

  it("marks the task CANCELLED when the agent invocation is cancelled", async () => {
    wireOrchestrator({ agent: agentIsCancelled() });

    const outcome = await orchestrator.run(taskId);

    expectCancelled(outcome);
    expect(outcome.reason).toContain("cancelled");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("CANCELLED");
    expect(attempt?.failure).toMatchObject({ kind: "cancelled" });
    expect((await storedTask()).status).toBe("CANCELLED");
    expect(verification.runs).toHaveLength(0);

    const events = await store.listEvents({ taskId });
    expect(eventPayload(events.at(-1)?.payload)).toMatchObject({
      from: "IMPLEMENTING",
      to: "CANCELLED",
    });
  });

  it("fails the task and removes the clean worktree when the agent produces no changes", async () => {
    wireOrchestrator({
      agent: () => ({
        kind: "success",
        output: { stdout: "nothing to do" },
        exitCode: 0,
        durationMs: 1,
      }),
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("no usable code changes");
    expect((await storedTask()).status).toBe("FAILED");
    expect(verification.runs).toHaveLength(0);
    expect(outcome.cleanup).toEqual({ kind: "removed" });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(false);
  });

  it("fails the task without verification, commit, or integration when a changed path is outside the allowed scope", async () => {
    wireOrchestrator({
      agent: agentAppliesChange({
        path: "root.txt",
        content: "outside scope\n",
      }),
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      "task scope violation: the following changed paths are outside the task scope",
    );
    expect(outcome.reason).toContain(
      "root.txt (no allowed path pattern matched)",
    );
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failure?.kind).toBe("error");
    expect(attempt?.failure?.message).toContain("root.txt");
    expect(verification.runs).toHaveLength(0);
    expect(await headRevision(`task/${taskId}/attempt-1`)).toBe(baseRevision);
    expect(await headRevision("HEAD")).toBe(baseRevision);

    const events = await store.listEvents({ taskId });
    expect(
      events.some(
        (event) => event.type === ORCHESTRATION_EVENTS.verificationCompleted,
      ),
    ).toBe(false);
    expect(
      events.some((event) => event.type === ORCHESTRATION_EVENTS.commitCreated),
    ).toBe(false);
    expect(
      events.some(
        (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
      ),
    ).toBe(false);
    expect(eventPayload(events.at(-1)?.payload)).toMatchObject({
      from: "IMPLEMENTING",
      to: "FAILED",
      attemptId: "att_M001_1",
    });
    expect(outcome.cleanup).toEqual({
      kind: "skipped",
      reason: "dirty-worktree",
    });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(true);
  });

  it("reports every violating path when multiple changed paths are outside the scope", async () => {
    wireOrchestrator({
      agent: (invocation) => {
        writeChangeAt(invocation.worktreePath, "z-root.txt", "z\n");
        writeChangeAt(invocation.worktreePath, "lib/other.md", "other\n");
        writeChangeAt(invocation.worktreePath, "src/inside.ts", "inside\n");
        return {
          kind: "success",
          output: { stdout: "wrote three files", stderr: "" },
          exitCode: 0,
          durationMs: 5,
        };
      },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      "lib/other.md (no allowed path pattern matched); z-root.txt (no allowed path pattern matched)",
    );
    expect(outcome.reason).not.toContain("src/inside.ts");
    expect((await storedTask()).status).toBe("FAILED");
    expect(verification.runs).toHaveLength(0);
  });

  it("fails when a changed path is forbidden even though it is also allowed", async () => {
    await seedScopedTask(taskId, ["src/**"], ["src/generated/**"]);
    wireOrchestrator({
      agent: agentAppliesChange({
        path: "src/generated/schema.ts",
        content: "export const schema = {};\n",
      }),
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      'src/generated/schema.ts (forbidden by "src/generated/**")',
    );
    expect((await storedTask()).status).toBe("FAILED");
    expect(verification.runs).toHaveLength(0);
    expect(await headRevision(`task/${taskId}/attempt-1`)).toBe(baseRevision);
    expect(await headRevision("HEAD")).toBe(baseRevision);
  });

  it("validates modified tracked files against the task scope", async () => {
    await seedScopedTask(taskId, ["**"], ["README.md"]);
    wireOrchestrator({
      agent: (invocation) => {
        writeChangeAt(invocation.worktreePath, "README.md", "modified\n");
        return {
          kind: "success",
          output: { stdout: "modified README.md", stderr: "" },
          exitCode: 0,
          durationMs: 5,
        };
      },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      'README.md (forbidden by "README.md")',
    );
    expect(verification.runs).toHaveLength(0);
    expect(await headRevision(`task/${taskId}/attempt-1`)).toBe(baseRevision);
  });

  it("validates deleted tracked files against the task scope", async () => {
    await seedScopedTask(taskId, ["**"], ["README.md"]);
    wireOrchestrator({
      agent: (invocation) => {
        unlinkSync(join(invocation.worktreePath, "README.md"));
        return {
          kind: "success",
          output: { stdout: "deleted README.md", stderr: "" },
          exitCode: 0,
          durationMs: 5,
        };
      },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      'README.md (forbidden by "README.md")',
    );
    expect(verification.runs).toHaveLength(0);
    expect(await headRevision(`task/${taskId}/attempt-1`)).toBe(baseRevision);
  });

  it("completes a valid scoped task that modifies and deletes tracked files", async () => {
    await seedScopedTask(taskId, ["**"], ["docs/**"]);
    wireOrchestrator({
      agent: (invocation) => {
        writeChangeAt(invocation.worktreePath, "README.md", "updated\n");
        unlinkSync(join(invocation.worktreePath, "AGENTS.md"));
        writeChangeAt(invocation.worktreePath, change.path, change.content);
        return {
          kind: "success",
          output: { stdout: "changed tracked files", stderr: "" },
          exitCode: 0,
          durationMs: 5,
        };
      },
    });

    const outcome = await orchestrator.run(taskId);

    expectCompleted(outcome);
    expect(verification.runs).toHaveLength(1);
    expect((await storedTask()).status).toBe("DONE");
    expect(await headRevision("HEAD")).not.toBe(baseRevision);
  });

  it("validates the previous path of renamed files against the task scope", async () => {
    await commitFixtureFile("docs/legacy.txt", "legacy\n");
    await seedScopedTask(taskId, ["**"], ["docs/**"]);
    wireOrchestrator({ agent: agentRenamesViaGit("docs/legacy.txt", "moved-legacy.txt") });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      'docs/legacy.txt (forbidden by "docs/**")',
    );
    expect(verification.runs).toHaveLength(0);
    const taskBase = await headRevision("HEAD");
    expect(await headRevision(`task/${taskId}/attempt-1`)).toBe(taskBase);
  });

  it("completes a scoped task whose staged rename stays inside the allowed paths", async () => {
    await commitFixtureFile("src/keep.txt", "keep\n");
    const taskBase = await headRevision("HEAD");
    await seedScopedTask(taskId, ["src/**"], ["docs/**"]);
    wireOrchestrator({ agent: agentRenamesViaGit("src/keep.txt", "src/renamed.txt") });

    const outcome = await orchestrator.run(taskId);

    expectCompleted(outcome);
    expect(verification.runs).toHaveLength(1);
    expect((await storedTask()).status).toBe("DONE");
    expect(await headRevision(`task/${taskId}/attempt-1`)).not.toBe(taskBase);
  });

  it("matches repository-relative scope patterns against Windows-style host paths", async () => {
    wireOrchestrator({ agent: agentAppliesChange(change) });
    const scopedGit = withExtraStatusEntries(git, [
      {
        indexStatus: "?",
        worktreeStatus: "?",
        path: "docs\\secret.md",
      },
    ]);
    orchestrator = createSingleTaskOrchestrator({
      store,
      git: scopedGit,
      agent,
      verification,
      verificationChecks: [
        { name: "typecheck", executable: "node", args: ["--version"] },
        { name: "unit", executable: "node", args: ["--version"] },
      ],
      projectRoot: repoPath,
      worktreesDir,
      agentTimeoutMs: 5_000,
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain(
      'docs/secret.md (forbidden by "docs/**")',
    );
    expect(verification.runs).toHaveLength(0);
  });

  it("completes a scoped task when the Git layer reports Windows-style host paths", async () => {
    const scopedGit = withExtraStatusEntries(git, [
      { indexStatus: "M", worktreeStatus: "M", path: "src\\utils.ts" },
    ]);
    wireOrchestrator({ agent: agentAppliesChange(change) });
    orchestrator = createSingleTaskOrchestrator({
      store,
      git: scopedGit,
      agent,
      verification,
      verificationChecks: [
        { name: "typecheck", executable: "node", args: ["--version"] },
        { name: "unit", executable: "node", args: ["--version"] },
      ],
      projectRoot: repoPath,
      worktreesDir,
      agentTimeoutMs: 5_000,
    });

    const outcome = await orchestrator.run(taskId);

    expectCompleted(outcome);
    expect(verification.runs).toHaveLength(1);
    expect((await storedTask()).status).toBe("DONE");
  });

  it("prevents commit, integration, and DONE when verification fails", async () => {
    wireOrchestrator({
      agent: agentAppliesChange(change),
      verification: (input) =>
        failedVerificationRun(input, "typecheck", "typecheck exited with code 2"),
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("verification failed");
    expect(outcome.reason).toContain("typecheck");
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failure).toMatchObject({ kind: "verification_failed" });

    const branchHead = await headRevision(`task/${taskId}/attempt-1`);
    expect(branchHead).toBe(baseRevision);
    expect(await headRevision("HEAD")).toBe(baseRevision);
    expect(outcome.cleanup).toEqual({ kind: "skipped", reason: "dirty-worktree" });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(true);

    const events = await store.listEvents({ taskId });
    const verificationIndex = events.findIndex(
      (event) => event.type === ORCHESTRATION_EVENTS.verificationCompleted,
    );
    const failureIndex = events.findIndex(
      (event) => eventPayload(event.payload).to === "FAILED",
    );
    expect(verificationIndex).toBeGreaterThan(-1);
    expect(verificationIndex).toBeLessThan(failureIndex);
    expect(events[verificationIndex]?.payload).toMatchObject({
      status: "FAILED",
    });
    expect(eventPayload(events.at(-1)?.payload)).toMatchObject({
      from: "VERIFYING",
      to: "FAILED",
    });
  });

  it("marks the task CANCELLED when verification is cancelled", async () => {
    wireOrchestrator({
      agent: agentAppliesChange(change),
      verification: (input) => cancelledVerificationRun(input),
    });

    const outcome = await orchestrator.run(taskId);

    expectCancelled(outcome);
    expect(outcome.reason).toContain("verification was cancelled");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("CANCELLED");
    expect(attempt?.failure).toMatchObject({ kind: "cancelled" });
    expect((await storedTask()).status).toBe("CANCELLED");
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(true);
  });

  it("prevents integration and DONE when the commit fails", async () => {
    wireOrchestrator({
      agent: agentAppliesChange(change),
      gitFailures: { commitStaged: gitFailure("commitStaged") },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("commitStaged");
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failure).toMatchObject({ kind: "error" });

    const branchHead = await headRevision(`task/${taskId}/attempt-1`);
    expect(branchHead).toBe(baseRevision);
    expect(await headRevision("HEAD")).toBe(baseRevision);
    expect(outcome.cleanup).toEqual({ kind: "skipped", reason: "dirty-worktree" });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(true);

    const events = await store.listEvents({ taskId });
    expect(eventPayload(events.at(-1)?.payload)).toMatchObject({
      from: "VERIFYING",
      to: "FAILED",
    });
  });

  it("prevents DONE when integration fails and reports the failure", async () => {
    wireOrchestrator({
      agent: agentAppliesChange(change),
      gitFailures: { integrateBranch: gitFailure("integrateBranch") },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("integrateBranch");
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("FAILED");

    const branchHead = await headRevision(`task/${taskId}/attempt-1`);
    expect(branchHead).not.toBe(baseRevision);
    expect(await headRevision("HEAD")).toBe(baseRevision);
    expect(outcome.cleanup).toEqual({ kind: "removed" });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(false);

    const events = await store.listEvents({ taskId });
    expect(
      events.some(
        (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
      ),
    ).toBe(false);
    expect(eventPayload(events.at(-1)?.payload)).toMatchObject({
      from: "INTEGRATING",
      to: "FAILED",
    });
  });

  it("fails cleanly and skips cleanup when worktree creation fails", async () => {
    wireOrchestrator({
      gitFailures: { createWorktree: gitFailure("createWorktree") },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.reason).toContain("createWorktree");
    expect((await storedTask()).status).toBe("FAILED");
    const attempt = (await storedAttempts())[0];
    expect(attempt?.status).toBe("FAILED");
    expect(agent.invocations).toHaveLength(0);
    expect(verification.runs).toHaveLength(0);
    expect(outcome.cleanup).toBeUndefined();
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(false);
  });

  it("skips cleanup when the worktree status cannot be determined", async () => {
    wireOrchestrator({
      agent: agentFails("agent process crashed"),
      gitFailures: { status: gitFailure("status") },
    });

    const outcome = await orchestrator.run(taskId);

    expectFailed(outcome);
    expect(outcome.cleanup).toEqual({
      kind: "skipped",
      reason: "status-unavailable",
    });
    expect(existsSync(join(worktreesDir, taskId, "attempt-1"))).toBe(true);
  });

  it("rejects runs before they start when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    wireOrchestrator({ signal: controller.signal });

    const outcome = await orchestrator.run(taskId);

    expectRejected(outcome);
    expect(outcome.reason).toContain("aborted");
    expect(agent.invocations).toHaveLength(0);
    expect((await storedTask()).status).toBe("READY");
  });

  it("rejects concurrent run invocations of the same orchestrator", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    wireOrchestrator({
      agent: async (invocation) => {
        writeChangeAt(invocation.worktreePath, change.path, change.content);
        await gate;
        return {
          kind: "success",
          output: { stdout: `wrote ${change.path}` },
          exitCode: 0,
          durationMs: 1,
        };
      },
    });

    const first = orchestrator.run(taskId);

    await expect(orchestrator.run(taskId)).rejects.toThrow(OrchestrationError);

    release();
    expectCompleted(await first);
  });

  it("rejects the run when the project root is not a Git repository", async () => {
    const notARepository = join(directory, "plain dir");
    mkdirSync(notARepository);
    wireOrchestrator({ projectRoot: notARepository });

    const outcome = await orchestrator.run(taskId);

    expectRejected(outcome);
    expect(outcome.reason).toContain("not a Git repository");
    expect(await store.listAttempts({ taskId })).toHaveLength(0);
  });

  it("rejects the run when a required verification command is not configured", async () => {
    const task = createTask({ id: "M002", status: "READY" });
    await store.putTask({
      ...task,
      definition: {
        ...task.definition,
        verification: { required: ["typecheck", "e2e"] },
      },
    });

    const outcome = await orchestrator.run("M002");

    expectRejected(outcome);
    expect(outcome.reason).toContain("e2e");
    expect(await store.listAttempts({ taskId: "M002" })).toHaveLength(0);
  });

  it("keeps provider-specific, raw process, git, and SQL behavior out of the orchestrator", () => {
    const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
    const sources = readdirSync(sourceDirectory)
      .filter((file) => file.endsWith(".ts"))
      .map((file) =>
        readFileSync(join(sourceDirectory, file), "utf8"),
      )
      .join("\n");

    const forbidden = [
      "node:sqlite",
      "node:child_process",
      "execFile",
      "spawnSync",
      "--ff-only",
      "rev-parse",
      "worktree add",
      "BEGIN IMMEDIATE",
      "INSERT INTO",
      "SELECT ",
      "opencode",
    ];
    for (const token of forbidden) {
      expect(sources).not.toContain(token);
    }
  });

  async function headRevision(revision: string): Promise<string> {
    const output = await runFixtureGit(runner, repoPath, [
      "rev-parse",
      revision,
    ]);
    return output.trim();
  }
});
