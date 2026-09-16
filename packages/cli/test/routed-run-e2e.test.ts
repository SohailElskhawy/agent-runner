import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { OpenCodeAdapter } from "@agentic-dev-runner/agents";
import type { AgentAvailability, AgentRegistry } from "@agentic-dev-runner/agents";
import { runCli } from "../src/run-cli.js";
import { createAppServices } from "../src/application/app-services.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import type { RunnerAppService } from "../src/application/runner-app-service.js";
import { captureIo } from "./fixtures.js";

const FAKE_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-coding-agent.mjs", import.meta.url),
);

const TASK_ID = "R001";
const CLAMP_SOURCE = "src/math/clamp.cjs";

const VERIFICATION_YAML = [
  "verification:",
  "  checks:",
  "    typecheck:",
  "      command: node",
  "      args:",
  "        - --check",
  `        - ${CLAMP_SOURCE}`,
  "    unit:",
  "      command: node",
  "      args:",
  "        - --test",
  "        - test/**/*.test.cjs",
  "",
].join("\n");

const PROJECT_CONFIG_YAML = [
  VERIFICATION_YAML,
  "agents:",
  "  profiles:",
  "    opencode-fixture:",
  "      adapter: opencode",
  "      model: fake/gpt-5",
  "      capabilities:",
  "        - javascript",
  "",
].join("\n");

const PROJECT_CONFIG_WITHOUT_PROFILES_YAML = VERIFICATION_YAML;

const PROJECT_CONFIG_WITH_UNKNOWN_ADAPTER_YAML = [
  VERIFICATION_YAML,
  "agents:",
  "  profiles:",
  "    unknown-fixture:",
  "      adapter: claude",
  "      capabilities:",
  "        - javascript",
  "",
].join("\n");

const AGENTS_MARKDOWN = [
  "# Fixture rules",
  "",
  "- Implement one validated utility function per task with tests.",
  "",
].join("\n");

const VALIDATE_SOURCE = [
  "function isFiniteNumber(value) {",
  '  return typeof value === "number" && Number.isFinite(value);',
  "}",
  "",
  "module.exports = { isFiniteNumber };",
  "",
].join("\n");

const VALIDATE_TEST = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const { isFiniteNumber } = require("../../src/math/validate.cjs");',
  "",
  'test("isFiniteNumber accepts finite numbers", () => {',
  "  assert.equal(isFiniteNumber(1), true);",
  '  assert.equal(isFiniteNumber("1"), false);',
  "});",
  "",
].join("\n");

function routedTask(): Task {
  return {
    id: TASK_ID,
    projectId: "proj-local",
    title: "Add a small validated utility function with tests.",
    milestone: "agent-routing",
    status: "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective:
        "Create src/math/clamp.cjs exporting clamp(value, min, max) with input validation.",
      acceptanceCriteria: [
        "src/math/clamp.cjs exports clamp(value, min, max).",
      ],
      scope: { allowedPaths: ["src/**", "test/**"], forbiddenPaths: [] },
      resources: [],
      verification: { required: ["typecheck", "unit"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: false },
    },
    routing: { complexity: "small", capabilities: ["javascript"] },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("M063b routed agentic run through the CLI entry point", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let runner: ProcessRunner;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m063b-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    runner = createNodeProcessRunner();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  async function createFixtureRepository(
    projectConfigYaml: string,
  ): Promise<void> {
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, "AGENTS.md"), AGENTS_MARKDOWN);
    writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
    writeFileSync(join(repositoryPath, "agentic.yaml"), projectConfigYaml);
    mkdirSync(join(repositoryPath, "src", "math"), { recursive: true });
    writeFileSync(join(repositoryPath, "src", "math", "validate.cjs"), VALIDATE_SOURCE);
    mkdirSync(join(repositoryPath, "test", "math"), { recursive: true });
    writeFileSync(join(repositoryPath, "test", "math", "validate.test.cjs"), VALIDATE_TEST);
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

  function fakeOpencodeAdapterRegistry() {
    return createAgentAdapterRegistry([
      new OpenCodeAdapter(runner, {
        executable: process.execPath,
        launcherArgs: [FAKE_AGENT_SCRIPT],
      }),
    ]);
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

  function services(): Promise<RunnerAppService> {
    return (async () => {
      const appServices = await createAppServices(
        {
          projectRoot: repositoryPath,
          stateDir,
          agentTimeoutMs: 60_000,
        },
        {
          agentRegistry: stubAvailability(),
          agentAdapters: fakeOpencodeAdapterRegistry(),
        },
      );
      return createStoreBackedAppService({
        storePath: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
        projectRoot: repositoryPath,
        store: appServices.store,
        orchestrator: appServices.orchestrator,
        recovery: appServices.recovery,
        agents: appServices.agents,
      });
    })();
  }

  async function openRepositoryStore(): Promise<RunnerStore> {
    const seeded = createSqliteRunnerStore({
      path: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
    });
    await seeded.initialize();
    return seeded;
  }

  async function seedTask(): Promise<void> {
    store = await openRepositoryStore();
    await store.putTask(routedTask());
    await store.close();
    store = undefined;
  }

  it("routes the task to the configured opencode profile and executes it to DONE with the profile model", async () => {
    await createFixtureRepository(PROJECT_CONFIG_YAML);
    const initIo = captureIo();
    expect(await runCli(["init"], { io: initIo.io, servicesFactory: services })).toBe(0);

    await seedTask();

    const runIo = captureIo();
    const exitCode = await runCli(["run", TASK_ID], {
      io: runIo.io,
      servicesFactory: services,
    });

    expect(
      exitCode,
      `run failed: lines=${JSON.stringify(runIo.lines)} errors=${JSON.stringify(runIo.errors)}`,
    ).toBe(0);
    expect(runIo.lines.join("\n")).toContain("completed");

    const reopened = await openRepositoryStore();
    store = reopened;
    expect((await reopened.getTask(TASK_ID))?.status).toBe("DONE");
    const attempts = await reopened.listAttempts({ taskId: TASK_ID });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.agent).toBe("opencode");
    expect(attempts[0]?.model).toBe("fake/gpt-5");
    expect(attempts[0]?.status).toBe("SUCCEEDED");
    expect(readFileSync(join(repositoryPath, CLAMP_SOURCE), "utf8")).toContain(
      "module.exports = { clamp };",
    );
  }, 60_000);

  it("fails the run with routing diagnostics and starts no attempt when no profiles are configured", async () => {
    await createFixtureRepository(PROJECT_CONFIG_WITHOUT_PROFILES_YAML);
    const initIo = captureIo();
    expect(await runCli(["init"], { io: initIo.io, servicesFactory: services })).toBe(0);

    await seedTask();

    const runIo = captureIo();
    const exitCode = await runCli(["run", TASK_ID], {
      io: runIo.io,
      servicesFactory: services,
    });

    expect(exitCode).toBe(1);
    const stderr = runIo.errors.join("\n");
    expect(stderr).toContain(`no agent profile can route task "${TASK_ID}"`);
    expect(stderr).toContain("no agent profiles are configured");

    const reopened = await openRepositoryStore();
    store = reopened;
    expect((await reopened.getTask(TASK_ID))?.status).toBe("READY");
    expect(await reopened.listAttempts({ taskId: TASK_ID })).toHaveLength(0);
  }, 60_000);

  it("treats a configured unknown adapter as unavailable without crashing or falling back", async () => {
    await createFixtureRepository(PROJECT_CONFIG_WITH_UNKNOWN_ADAPTER_YAML);
    const initIo = captureIo();
    expect(await runCli(["init"], { io: initIo.io, servicesFactory: services })).toBe(0);

    await seedTask();

    const runIo = captureIo();
    const exitCode = await runCli(["run", TASK_ID], {
      io: runIo.io,
      servicesFactory: services,
    });

    expect(exitCode).toBe(1);
    const stderr = runIo.errors.join("\n");
    expect(stderr).toContain(`no agent profile can route task "${TASK_ID}"`);
    expect(stderr).toContain('references unknown adapter "claude" with no discovery result');

    const reopened = await openRepositoryStore();
    store = reopened;
    expect((await reopened.getTask(TASK_ID))?.status).toBe("READY");
    expect(await reopened.listAttempts({ taskId: TASK_ID })).toHaveLength(0);
  }, 60_000);
});
