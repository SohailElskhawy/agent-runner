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
  AgentRegistry,
} from "@agentic-dev-runner/agents";
import { runCli } from "../src/run-cli.js";
import { createAppServices } from "../src/application/app-services.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { captureIo } from "./fixtures.js";

const WORKFLOW_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-workflow-agent.mjs", import.meta.url),
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

const TASK_DEFAULT_JSON = JSON.stringify({
  id: "W1",
  title: "Add the workflow describe utility",
  milestone: "run-task-workflow",
  status: "ready",
  priority: "P0",
  risk: "low",
  type: "implementation",
  objective:
    "Create src/workflow/W1.cjs exporting describe(), and test/workflow/W1.test.cjs covering it.",
  acceptance_criteria: ["src/workflow/W1.cjs exports describe."],
  depends_on: [],
  provenance: { kind: "user_request", source: "manual" },
  scope: { allowed_paths: ["src/workflow/**", "test/workflow/**"], forbidden_paths: [] },
  resources: ["resource-w1"],
  workflow: "default",
  routing: { complexity: "small", capabilities: ["javascript"] },
  verification: { required: ["unit"] },
  limits: { max_attempts: 3, max_review_cycles: 2 },
  approval: { required: false },
});

const TASK_SIMPLE_JSON = JSON.stringify({
  id: "W2",
  title: "Add the simple workflow describe utility",
  milestone: "run-task-workflow",
  status: "ready",
  priority: "P0",
  risk: "low",
  type: "implementation",
  objective:
    "Create src/workflow/W2.cjs exporting describe(), and test/workflow/W2.test.cjs covering it.",
  acceptance_criteria: ["src/workflow/W2.cjs exports describe."],
  depends_on: [],
  provenance: { kind: "user_request", source: "manual" },
  scope: { allowed_paths: ["src/workflow/**", "test/workflow/**"], forbidden_paths: [] },
  resources: ["resource-w2"],
  workflow: "simple",
  routing: { complexity: "small", capabilities: ["javascript"] },
  verification: { required: ["unit"] },
  limits: { max_attempts: 3, max_review_cycles: 2 },
  approval: { required: false },
});

describe("run <task-id> through the workflow pipeline", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let tasksDir: string;
  let runner: ProcessRunner;
  let adapter: OpenCodeAdapter;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-run-workflow-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    tasksDir = join(directory, "tasks");
    runner = createNodeProcessRunner();
    adapter = new OpenCodeAdapter(runner, {
      executable: process.execPath,
      launcherArgs: [WORKFLOW_AGENT_SCRIPT],
    });
    await createFixtureRepository();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  async function createFixtureRepository(): Promise<void> {
    mkdirSync(repositoryPath, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
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
      { id: "opencode", available: true, version: "fake opencode 1.0.0", reason: null },
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

  async function initAndAddTask(taskId: string, taskJson: string): Promise<void> {
    const initIo = captureIo();
    expect(await runCli(["init"], { io: initIo.io, servicesFactory: servicesFactory() })).toBe(0);
    const taskPath = join(tasksDir, `task-${taskId}.json`);
    writeFileSync(taskPath, taskJson, "utf8");
    const addIo = captureIo();
    const exit = await runCli(["tasks", "add", taskPath], {
      io: addIo.io,
      servicesFactory: servicesFactory(),
    });
    expect(exit, `tasks add ${taskId} failed: ${addIo.errors.join("\n")}`).toBe(0);
  }

  function describeRun(exitCode: number, io: { lines: string[]; errors: string[] }): string {
    return `run exit ${String(exitCode)}: lines=${JSON.stringify(io.lines)} errors=${JSON.stringify(io.errors)}`;
  }

  it("runs the full default workflow and integration verification for run <task-id>", async () => {
    await initAndAddTask("W1", TASK_DEFAULT_JSON);
    const runIo = captureIo();
    const runExit = await runCli(["run", "W1"], {
      io: runIo.io,
      servicesFactory: servicesFactory(),
    });

    store = await openRepositoryStore();
    const attempt = (await store.listAttempts({ taskId: "W1" })).at(-1)!;
    const stages = (await store.listStageRuns(attempt.id)).map((run) => run.stage);
    expect(stages, describeRun(runExit, runIo)).toEqual([
      "PLAN",
      "PLAN_REVIEW",
      "IMPLEMENT",
      "CODE_REVIEW",
      "VERIFY",
      "INTEGRATE",
    ]);
    expect(runExit, describeRun(runExit, runIo)).toBe(0);
    expect((await store.getTask("W1"))?.status).toBe("DONE");
    const integrationVerification = await store.listEvents({
      type: "integration.verification.completed",
    });
    expect(integrationVerification.map((event) => event.taskId)).toEqual(["W1"]);
    const subjects = (await git(["log", "--format=%s"])).split("\n");
    expect(subjects).toContain("task W1: Add the workflow describe utility");
  }, 120_000);

  it("records integration verification for a simple workflow task", async () => {
    await initAndAddTask("W2", TASK_SIMPLE_JSON);
    const runIo = captureIo();
    const runExit = await runCli(["run", "W2"], {
      io: runIo.io,
      servicesFactory: servicesFactory(),
    });

    store = await openRepositoryStore();
    const attempt = (await store.listAttempts({ taskId: "W2" })).at(-1)!;
    const stages = (await store.listStageRuns(attempt.id)).map((run) => run.stage);
    expect(stages, describeRun(runExit, runIo)).toEqual([
      "IMPLEMENT",
      "VERIFY",
      "INTEGRATE",
    ]);
    expect(runExit, describeRun(runExit, runIo)).toBe(0);
    expect((await store.getTask("W2"))?.status).toBe("DONE");
    const integrationVerification = await store.listEvents({
      type: "integration.verification.completed",
    });
    expect(integrationVerification.map((event) => event.taskId)).toEqual(["W2"]);
    const subjects = (await git(["log", "--format=%s"])).split("\n");
    expect(subjects).toContain("task W2: Add the simple workflow describe utility");
  }, 120_000);
});
