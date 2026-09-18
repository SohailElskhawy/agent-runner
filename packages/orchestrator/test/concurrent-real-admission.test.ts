import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentDescriptor,
  AgentExecutionResult,
  AgentInvocation,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import {
  SIMPLE_WORKFLOW,
  type AgentRouteCandidate,
  type Task,
} from "@agentic-dev-runner/core";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createGitManager } from "@agentic-dev-runner/git";
import {
  createTaskExecutionCoordinator,
  createWorkflowTaskExecutor,
} from "../src/index.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  passedVerificationRun,
} from "./fixtures.js";

describe("real concurrent admission and attempt creation", () => {
  let directory: string;
  let repositoryPath: string;
  let worktreesDir: string;
  let storeA: RunnerStore;
  let storeB: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-real-admission-"));
    repositoryPath = join(directory, "repository");
    worktreesDir = join(directory, "worktrees");
    const runner = createNodeProcessRunner();
    await createFixtureRepository({
      runner,
      repositoryPath,
      agentsMarkdown: AGENTS_MARKDOWN,
    });
    const dbPath = join(directory, "state.db");
    storeA = createSqliteRunnerStore({ path: dbPath });
    storeB = createSqliteRunnerStore({ path: dbPath });
    await storeA.initialize();
    await storeB.initialize();
    await storeA.putProject(createProject({ rootPath: repositoryPath }));
    await storeA.putTask(realTask("A"));
    await storeA.putTask(realTask("B"));
  });

  afterEach(async () => {
    await storeA.close();
    await storeB.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates one real attempt and admits the second task after capacity is released", async () => {
    const runner = createNodeProcessRunner();
    const agent = new BarrierAgent();
    const candidate: AgentRouteCandidate = {
      profile: {
        id: "fixture-profile",
        adapterId: "fixture-agent",
        capabilities: ["typescript"],
      },
      availability: { id: "fixture-agent", available: true },
    };
    const createCoordinator = (store: RunnerStore) =>
      createTaskExecutionCoordinator({
        store,
        agentCandidates: [candidate],
        maxParallelism: 1,
        createExecutor: (task, executionId) =>
          createWorkflowTaskExecutor({
            store,
            git: createGitManager({ runner }),
            agent,
            verification: {
              async run(input) {
                return passedVerificationRun(input);
              },
            },
            verificationChecks: [{ name: "unit", executable: "node" }],
            task,
            workflow: SIMPLE_WORKFLOW,
            projectRoot: repositoryPath,
            worktreesDir,
            agentTimeoutMs: 30_000,
            executionId,
          }),
      });
    const first = createCoordinator(storeA);
    const second = createCoordinator(storeB);

    const firstRun = first.dispatchAvailable();
    const secondRun = second.dispatchAvailable();
    await agent.started;
    const secondResult = await secondRun;
    expect(secondResult.executions).toEqual([]);
    agent.release();
    await firstRun;

    const firstAttempts = await storeA.listAttempts({ taskId: "A" });
    expect(firstAttempts.map((attempt) => attempt.number)).toEqual([1]);
    expect((await storeA.getTask("A"))?.status).toBe("DONE");

    const next = await second.dispatchAvailable();
    expect(next.executions).toHaveLength(1);
    const secondAttempts = await storeA.listAttempts({ taskId: "B" });
    expect(secondAttempts.map((attempt) => attempt.number)).toEqual([1]);
    expect((await storeA.getTask("B"))?.status).toBe("DONE");
    expect(await storeA.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await storeA.listResourceLocks()).toEqual([]);
  }, 30_000);
});

class BarrierAgent implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "fixture-agent" };
  readonly started: Promise<void>;
  private resolveStarted: (() => void) | undefined;
  private releasePromise: Promise<void>;
  private resolveRelease: (() => void) | undefined;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.releasePromise = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  release(): void {
    this.resolveRelease?.();
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    const taskId = invocation.contextPack.task.id;
    if (taskId === "A") {
      this.resolveStarted?.();
      await this.releasePromise;
    }
    const target = join(invocation.worktreePath, "src", `${taskId}.txt`);
    mkdirSync(join(invocation.worktreePath, "src"), { recursive: true });
    writeFileSync(target, `${taskId}\n`);
    return { kind: "success", output: { stdout: "ok" }, exitCode: 0, durationMs: 1 };
  }
}

function realTask(id: string): Task {
  const value = createTask({ id, status: "READY" });
  return {
    ...value,
    workflow: "simple",
    definition: {
      ...value.definition,
      resources: [],
      scope: { allowedPaths: [`src/${id}.txt`], forbiddenPaths: [] },
      verification: { required: ["unit"] },
    },
  };
}
