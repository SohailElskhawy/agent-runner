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
import {
  createIntegrationQueueProcessor,
  createTaskExecutionCoordinator,
  createUnattendedScheduler,
} from "../src/index.js";
import { createGitManager } from "@agentic-dev-runner/git";
import { createWorkflowTaskExecutor } from "../src/workflow-executor.js";
import {
  AGENTS_MARKDOWN,
  createFixtureRepository,
  createProject,
  createTask,
  passedVerificationRun,
} from "./fixtures.js";

describe("queued unattended scheduler integration", () => {
  let directory: string;
  let repositoryPath: string;
  let worktreesDir: string;
  let store: Awaited<ReturnType<typeof createSqliteRunnerStore>>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-queued-e2e-"));
    repositoryPath = join(directory, "repository");
    worktreesDir = join(directory, "worktrees");
    const runner = createNodeProcessRunner();
    await createFixtureRepository({
      runner,
      repositoryPath,
      agentsMarkdown: AGENTS_MARKDOWN,
    });
    store = createSqliteRunnerStore({ path: join(directory, "state.db") });
    await store.initialize();
    await store.putProject(createProject({ rootPath: repositoryPath }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("fails A, queues and integrates B, then runs dependent C", async () => {
    const taskA = e2eTask("A");
    const taskB = e2eTask("B");
    const taskC = { ...e2eTask("C"), dependsOn: ["B"] };
    await store.putTask(taskA);
    await store.putTask(taskB);
    await store.putTask(taskC);

    const runner = createNodeProcessRunner();
    const git = createGitManager({ runner });
    const verification = {
      async run(input: Parameters<typeof passedVerificationRun>[0]) {
        return passedVerificationRun(input);
      },
    };
    const agent = new FixtureAgent();
    const candidate: AgentRouteCandidate = {
      profile: {
        id: "fixture-profile",
        adapterId: "fixture-agent",
        capabilities: ["typescript"],
      },
      availability: { id: "fixture-agent", available: true },
    };
    const coordinator = createTaskExecutionCoordinator({
      store,
      agentCandidates: [candidate],
      maxParallelism: 2,
      createExecutor: (task, executionId) =>
        createWorkflowTaskExecutor({
          store,
          git,
          agent,
          verification,
          verificationChecks: [{ name: "unit", executable: "node" }],
          task,
          workflow: SIMPLE_WORKFLOW,
          projectRoot: repositoryPath,
          worktreesDir,
          agentTimeoutMs: 30_000,
          integrationMode: "queued",
          executionId,
        }),
    });
    const integration = createIntegrationQueueProcessor({
      store,
      git,
      verification,
      verificationChecks: [{ name: "unit", executable: "node" }],
      projectRoot: repositoryPath,
      worktreesDir,
    });

    const result = await createUnattendedScheduler({ coordinator, integration }).run();

    expect(result.kind).toBe("quiescent");
    expect(agent.invocations.slice(0, 2).sort()).toEqual(["A", "B"]);
    expect(agent.invocations[2]).toBe("C");
    expect((await store.getTask("A"))?.status).toBe("FAILED");
    expect((await store.getTask("B"))?.status).toBe("DONE");
    expect((await store.getTask("C"))?.status).toBe("DONE");
    const queue = await store.listIntegrationQueueEntries();
    expect(queue.map((entry) => [entry.taskId, entry.status])).toEqual([
      ["B", "COMPLETED"],
      ["C", "COMPLETED"],
    ]);
    expect(
      (await store.listEvents({ type: "integration.verification.completed" }))
        .map((event) => event.taskId),
    ).toEqual(["B", "C"]);
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);
  }, 30_000);
});

class FixtureAgent implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "fixture-agent" };
  readonly invocations: string[] = [];

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    const taskId = invocation.contextPack.task.id;
    this.invocations.push(taskId);
    if (taskId === "A") {
      return {
        kind: "failure",
        failure: { kind: "process", message: "fixture failure" },
        output: { stderr: "fixture failure" },
        durationMs: 1,
      };
    }
    const target = join(invocation.worktreePath, "src", `${taskId}.txt`);
    mkdirSync(join(invocation.worktreePath, "src"), { recursive: true });
    writeFileSync(target, `${taskId}\n`);
    return { kind: "success", output: { stdout: "ok" }, exitCode: 0, durationMs: 1 };
  }
}

function e2eTask(id: string): Task {
  const value = createTask({ id, status: "READY" });
  return {
    ...value,
    workflow: "simple",
    definition: {
      ...value.definition,
      resources: [`resource-${id}`],
      scope: { allowedPaths: [`src/${id}.txt`], forbiddenPaths: [] },
      verification: { required: ["unit"] },
    },
  };
}
