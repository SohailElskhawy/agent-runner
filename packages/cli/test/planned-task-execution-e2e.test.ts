import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OpenCodeAdapter } from "@agentic-dev-runner/agents";
import type { AgentAvailability, AgentDescriptor, AgentExecutionResult, AgentInvocation, AgentRegistry, AgentRuntime } from "@agentic-dev-runner/agents";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { runCli } from "../src/run-cli.js";
import { createAppServices } from "../src/application/app-services.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { captureIo } from "./fixtures.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-opencode-dag-agent.mjs", import.meta.url));

class FixtureAgent implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "opencode" };
  private readonly inner = new OpenCodeAdapter(createNodeProcessRunner(), {
    executable: process.execPath, launcherArgs: [FAKE_AGENT],
  });
  invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    return this.inner.invoke(invocation);
  }
}

const availableAgents: AgentRegistry = {
  agentIds: ["opencode"],
  async discoverAgents(): Promise<readonly AgentAvailability[]> {
    return [{ id: "opencode", available: true, version: "fixture", reason: null }];
  },
};

const CONFIG = [
  "verification:", "  checks:", "    unit:", "      command: node", "      args:", "        - --test", "        - test/todo.test.cjs",
  "agents:", "  profiles:",
  "    planner:", "      adapter: opencode", "      model: fake/planner", "      capabilities:", "        - planning",
  "    coding:", "      adapter: opencode", "      model: fake/coder", "      capabilities:", "        - javascript",
  "planning:", "  profile: planner", "",
].join("\n");

const AGENTS = "# Fixture rules\n\nUse small CommonJS modules and Node's built-in test runner.\n";

describe("planning to integrated TODO tasks", () => {
  let rootDir: string;
  let repositoryPath: string;
  let stateDir: string;
  let adapter: FixtureAgent;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "agentic-planning-e2e-"));
    repositoryPath = join(rootDir, "todo project");
    stateDir = join(rootDir, "runner state");
    adapter = new FixtureAgent();
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, "AGENTS.md"), AGENTS);
    writeFileSync(join(repositoryPath, "agentic.yaml"), CONFIG);
    writeFileSync(join(repositoryPath, "README.md"), "TODO dogfood fixture\n");
    const runner = createNodeProcessRunner();
    for (const args of [
      ["init"], ["config", "user.email", "runner@example.com"], ["config", "user.name", "Agentic Fixture"],
      ["add", "."], ["commit", "-m", "planning E2E seed"],
    ]) {
      if (args[0] === "init") mkdirSync(join(repositoryPath, ".git"), { recursive: true });
      const result = await runner.run({ executable: "git", args, cwd: repositoryPath });
      if (result.outcome.kind !== "completed" || result.outcome.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    rmSync(rootDir, { recursive: true, force: true });
  });

  function servicesFactory() {
    return async () => {
      const app = await createAppServices({ projectRoot: repositoryPath, stateDir, agentTimeoutMs: 60_000 }, {
        agentRegistry: availableAgents,
        agentAdapters: createAgentAdapterRegistry([adapter]),
      });
      return createStoreBackedAppService({
        storePath: resolveStorePath({ projectRoot: repositoryPath, stateDir }), projectRoot: repositoryPath,
        store: app.store, orchestrator: app.orchestrator, recovery: app.recovery, agents: app.agents,
        scheduler: app.scheduler, maxParallelism: app.maxParallelism, runner: app.runner,
        worktreesDir: join(stateDir, "worktrees"), configuration: app.configuration,
        configurationError: app.configurationError, analyzeRepository: app.analyzeRepository,
        planRepository: app.planRepository,
      });
    };
  }

  async function openStore(): Promise<RunnerStore> {
    const reopened = createSqliteRunnerStore({ path: resolveStorePath({ projectRoot: repositoryPath, stateDir }) });
    await reopened.initialize();
    return reopened;
  }

  it("asks a question, drafts without importing, then approves and runs the dependent TODO tasks", async () => {
    const init = captureIo();
    expect(await runCli(["init"], { io: init.io, servicesFactory: servicesFactory() })).toBe(0);

    const first = captureIo();
    const firstExit = await runCli(["plan", "--goal", "Build a small TODO list"], { io: first.io, servicesFactory: servicesFactory() });
    expect(firstExit, first.errors.join("\n")).toBe(0);
    expect(first.lines.join("\n")).toContain("NEEDS_DISCOVERY");
    expect(first.lines.join("\n")).toContain("storage");
    store = await openStore();
    expect(await store.listTasks()).toEqual([]);
    await store.close();
    store = undefined;

    const decisionsPath = join(repositoryPath, ".agentic", "decisions.md");
    writeFileSync(decisionsPath, readFileSync(decisionsPath, "utf8").replace("Answer: ", "Answer: In-memory for this demo"));
    const planned = captureIo();
    expect(await runCli(["plan", "--goal", "Build a small TODO list"], { io: planned.io, servicesFactory: servicesFactory() })).toBe(0);
    expect(planned.lines.join("\n")).toContain("plan-");
    store = await openStore();
    expect(await store.listTasks()).toEqual([]);
    await store.close();
    store = undefined;

    const plans = await import("node:fs/promises").then(({ readdir }) => readdir(join(repositoryPath, ".agentic", "plans")));
    const planId = plans.find((name) => /^plan-[a-f0-9]{16}$/.test(name));
    if (planId === undefined) throw new Error("planner did not write a draft");
    const approved = captureIo();
    expect(await runCli(["plan", "approve", planId], { io: approved.io, servicesFactory: servicesFactory() })).toBe(0);
    store = await openStore();
    expect((await store.listTasks()).map((task) => task.id).sort()).toEqual(["T001", "T002"]);
    await store.close();
    store = undefined;

    for (const args of [["add", ".agentic"], ["commit", "-m", "record planning decisions"]]) {
      const result = await createNodeProcessRunner().run({ executable: "git", args, cwd: repositoryPath });
      if (result.outcome.kind !== "completed" || result.outcome.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }

    const run = captureIo();
    expect(await runCli(["run"], { io: run.io, servicesFactory: servicesFactory() })).toBe(0);
    store = await openStore();
    expect((await store.listTasks()).map((task) => task.status)).toEqual(["DONE", "DONE"]);
    const queues = await store.listIntegrationQueueEntries();
    expect(queues).toHaveLength(2);
    expect(queues.every((entry) => entry.status === "COMPLETED")).toBe(true);
    expect(await store.listEvents({ type: "verification.completed" })).toHaveLength(2);
    expect(readFileSync(join(repositoryPath, "src", "todo.cjs"), "utf8")).toContain("completeTodo");
  });
});
