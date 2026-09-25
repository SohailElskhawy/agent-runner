import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { OpenCodeAdapter } from "@agentic-dev-runner/agents";
import type {
  AgentAvailability,
  AgentDescriptor,
  AgentExecutionResult,
  AgentInvocation,
  AgentRegistry,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import { runCli } from "../src/run-cli.js";
import { createAppServices } from "../src/application/app-services.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { captureIo } from "./fixtures.js";

const DAG_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-dag-agent.mjs", import.meta.url),
);

const AGENTS_MARKDOWN = [
  "# Fixture rules",
  "",
  "- Implement one validated utility function per task with tests.",
  "",
].join("\n");

const PROJECT_CONFIG_YAML = [
  "verification:",
  "  checks:",
  "    unit:",
  "      command: node",
  "      args:",
  "        - --test",
  "        - test/**/*.test.cjs",
  "agents:",
  "  profiles:",
  "    opencode-fixture:",
  "      adapter: opencode",
  "      model: fake/gpt-5",
  "      capabilities:",
  "        - javascript",
  "",
].join("\n");

const TASK_INPUTS: Readonly<Record<"F1" | "F2" | "N1", string>> = {
  F1: JSON.stringify({
    id: "F1",
    title: "Add the failing provider utility",
    milestone: "provider-failure",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective:
      "Create src/failed/failed.cjs exporting the failing-provider utility, and test/failed/failed.test.cjs covering it.",
    acceptance_criteria: ["src/failed/failed.cjs exports the utility."],
    depends_on: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: ["src/failed/**", "test/failed/**"], forbidden_paths: [] },
    resources: ["resource-f1"],
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  }),
  F2: JSON.stringify({
    id: "F2",
    title: "Add the foxtrot label utility",
    milestone: "provider-failure",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective:
      "Create src/foxtrot/foxtrot.cjs exporting toFoxtrotLabel with input validation, and test/foxtrot/foxtrot.test.cjs covering it.",
    acceptance_criteria: ["src/foxtrot/foxtrot.cjs exports toFoxtrotLabel."],
    depends_on: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: ["src/foxtrot/**", "test/foxtrot/**"], forbidden_paths: [] },
    resources: ["resource-f2"],
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  }),
  N1: JSON.stringify({
    id: "N1",
    title: "Add the unavailable provider utility",
    milestone: "provider-failure",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective:
      "Create src/november/november.cjs exporting the unavailable-provider utility, and test/november/november.test.cjs covering it.",
    acceptance_criteria: ["src/november/november.cjs exports the utility."],
    depends_on: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: ["src/november/**", "test/november/**"], forbidden_paths: [] },
    resources: ["resource-n1"],
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  }),
};

/**
 * Wraps the production OpenCode adapter and records every provider invocation.
 * The task whose context pack id is F1 gets a real adapter failure result
 * (`kind: "failure"`) instead of an agent process; every other task runs
 * through the fixture agent unchanged.
 */
class FailingForF1Adapter implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "opencode" };
  readonly invokedTaskIds: string[] = [];
  private readonly inner: AgentRuntime;

  constructor(runner: ProcessRunner) {
    this.inner = new OpenCodeAdapter(runner, {
      executable: process.execPath,
      launcherArgs: [DAG_AGENT_SCRIPT],
    });
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    const taskId = invocation.contextPack.task.id;
    this.invokedTaskIds.push(taskId);
    if (taskId === "F1") {
      return {
        kind: "failure",
        failure: { kind: "process", message: "fixture provider is down" },
        output: { stdout: "", stderr: "provider down" },
        durationMs: 1,
      };
    }
    return await this.inner.invoke(invocation);
  }
}

describe("provider failure isolation", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let tasksDir: string;
  let runner: ProcessRunner;
  let adapter: FailingForF1Adapter;
  let opencodeAvailable: boolean;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-provider-failure-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    tasksDir = join(directory, "tasks");
    runner = createNodeProcessRunner();
    adapter = new FailingForF1Adapter(runner);
    opencodeAvailable = true;
    mkdirSync(tasksDir, { recursive: true });
    await createFixtureRepository();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  async function createFixtureRepository(): Promise<void> {
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, "AGENTS.md"), AGENTS_MARKDOWN);
    writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
    writeFileSync(join(repositoryPath, "agentic.yaml"), PROJECT_CONFIG_YAML);
    const run = async (args: readonly string[]): Promise<void> => {
      const result = await runner.run({ executable: "git", args, cwd: repositoryPath });
      if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
        throw new Error(`fixture git command failed: git ${args.join(" ")}: ${result.stderr}`);
      }
    };
    await run(["init"]);
    await run(["config", "user.email", "runner@example.com"]);
    await run(["config", "user.name", "Agentic Runner Fixture"]);
    await run(["config", "core.autocrlf", "false"]);
    await run(["add", "."]);
    await run(["commit", "-m", "initial commit"]);
  }

  function stubAvailability(): AgentRegistry {
    const records: AgentAvailability[] = [
      {
        id: "opencode",
        available: opencodeAvailable,
        version: opencodeAvailable ? "fake opencode 1.0.0" : null,
        reason: opencodeAvailable ? null : "fake opencode is not installed",
      },
      { id: "codex", available: false, version: null, reason: "codex is not installed" },
    ];
    return {
      agentIds: records.map((record) => record.id),
      discoverAgents: async () => records,
    };
  }

  function servicesFactory() {
    return async () => {
      const appServices = await createAppServices(
        {
          projectRoot: repositoryPath,
          stateDir,
          agentTimeoutMs: 60_000,
        },
        {
          agentRegistry: stubAvailability(),
          agentAdapters: createAgentAdapterRegistry([adapter]),
        },
      );
      return createStoreBackedAppService({
        storePath: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
        projectRoot: repositoryPath,
        store: appServices.store,
        orchestrator: appServices.orchestrator,
        recovery: appServices.recovery,
        agents: appServices.agents,
        scheduler: appServices.scheduler,
        maxParallelism: appServices.maxParallelism,
      });
    };
  }

  async function openRepositoryStore(): Promise<RunnerStore> {
    const reopened = createSqliteRunnerStore({
      path: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
    });
    await reopened.initialize();
    return reopened;
  }

  async function git(args: readonly string[]): Promise<string> {
    const result = await runner.run({ executable: "git", args, cwd: repositoryPath });
    if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
      throw new Error(`fixture git command failed: git ${args.join(" ")}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async function initializeRunner(): Promise<void> {
    const io = captureIo();
    const exit = await runCli(["init"], { io: io.io, servicesFactory: servicesFactory() });
    expect(exit, `init failed: ${io.errors.join("\n")}`).toBe(0);
  }

  async function addTask(taskId: keyof typeof TASK_INPUTS): Promise<void> {
    const taskFile = join(tasksDir, `task-${taskId}.json`);
    writeFileSync(taskFile, TASK_INPUTS[taskId], "utf8");
    const io = captureIo();
    const exit = await runCli(["tasks", "add", taskFile], {
      io: io.io,
      servicesFactory: servicesFactory(),
    });
    expect(exit, `tasks add ${taskId} failed: ${io.errors.join("\n")}`).toBe(0);
  }

  it("keeps independent work running when one task's provider fails", async () => {
    await initializeRunner();
    await addTask("F1");
    await addTask("F2");

    const runIo = captureIo();
    const runExit = await runCli(["run", "--parallel", "2"], {
      io: runIo.io,
      servicesFactory: servicesFactory(),
    });
    expect(
      runExit,
      `run failed: lines=${JSON.stringify(runIo.lines)} errors=${JSON.stringify(runIo.errors)}`,
    ).toBe(0);

    store = await openRepositoryStore();

    // ---- The failed provider left its task FAILED, nothing more -----------
    expect((await store.getTask("F1"))?.status).toBe("FAILED");
    const f1Attempts = await store.listAttempts({ taskId: "F1" });
    expect(f1Attempts).toHaveLength(1);
    expect(f1Attempts[0]?.status).toBe("FAILED");
    expect(f1Attempts[0]?.failure?.kind).toBe("error");
    expect(f1Attempts[0]?.failure?.message).toContain("fixture provider is down");

    // ---- Independent work completed through the real production path -----
    expect((await store.getTask("F2"))?.status).toBe("DONE");
    const f2Attempts = await store.listAttempts({ taskId: "F2" });
    expect(f2Attempts.at(-1)?.status).toBe("SUCCEEDED");
    expect(f2Attempts.at(-1)?.failure).toBeUndefined();
    const f2Verification = await store.listEvents({
      taskId: "F2",
      type: "verification.completed",
    });
    expect(f2Verification.length).toBeGreaterThanOrEqual(1);
    expect(
      f2Verification.every(
        (event) => (event.payload as { status: string }).status === "PASSED",
      ),
    ).toBe(true);
    expect(
      (await store.listEvents({ taskId: "F2", type: "integration.verification.completed" }))
        .length,
    ).toBe(1);

    // ---- No execution residue survives the failure -----------------------
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);

    // ---- Git history carries F2's commit only ----------------------------
    const logSubjects = (await git(["log", "--format=%s"])).split("\n");
    expect(logSubjects.some((subject) => subject.startsWith("task F2: "))).toBe(true);
    expect(logSubjects.some((subject) => subject.startsWith("task F1: "))).toBe(false);
    expect((await git(["rev-list", "--count", "HEAD"])).trim()).toBe("2");

    // ---- The provider boundary saw both tasks independently --------------
    expect([...adapter.invokedTaskIds].sort()).toEqual(["F1", "F2"]);
  }, 120_000);

  it("creates no attempt when no configured adapter can run", async () => {
    opencodeAvailable = false;
    await initializeRunner();
    await addTask("N1");

    const runIo = captureIo();
    const runExit = await runCli(["run", "--parallel", "2"], {
      io: runIo.io,
      servicesFactory: servicesFactory(),
    });
    // No runnable agent is an observable quiescence, not a crash: the
    // scheduler reports quiescent, which the CLI maps to exit 0.
    expect(
      runExit,
      `run failed: lines=${JSON.stringify(runIo.lines)} errors=${JSON.stringify(runIo.errors)}`,
    ).toBe(0);

    store = await openRepositoryStore();

    // ---- The task stays READY and no attempt artifact was created --------
    expect((await store.getTask("N1"))?.status).toBe("READY");
    expect(await store.listAttempts({ taskId: "N1" })).toEqual([]);
    expect(
      (await store.listEvents({ taskId: "N1", type: "attempt.started" })).length,
    ).toBe(0);
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);

    // ---- The unavailable provider was never invoked ----------------------
    expect(adapter.invokedTaskIds).toEqual([]);
  }, 60_000);
});
