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
import { runCli } from "../src/run-cli.js";
import { createAppServices } from "../src/application/app-services.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { captureIo } from "./fixtures.js";

const FAKE_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-coding-agent.mjs", import.meta.url),
);

const TASK_ID = "T001";
const CLAMP_SOURCE = "src/math/clamp.cjs";
const CLAMP_TEST = "test/math/clamp.test.cjs";

const PROJECT_CONFIG_YAML = [
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

function manualTask(): Task {
  return {
    id: TASK_ID,
    projectId: "proj-local",
    title: "Add a small validated utility function with tests.",
    milestone: "vertical-slice",
    status: "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective:
        "Create src/math/clamp.cjs exporting clamp(value, min, max) with input validation, and test/math/clamp.test.cjs covering it.",
      acceptanceCriteria: [
        "src/math/clamp.cjs exports clamp(value, min, max).",
        "clamp returns value restricted to the inclusive range and throws a TypeError on non-number input.",
        "test/math/clamp.test.cjs covers both behaviors.",
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

describe("VS014 vertical slice through the CLI entry point", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let runner: ProcessRunner;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-vs014-cli-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    runner = createNodeProcessRunner();
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
    mkdirSync(join(repositoryPath, "src", "math"), { recursive: true });
    writeFileSync(
      join(repositoryPath, "src", "math", "validate.cjs"),
      VALIDATE_SOURCE,
    );
    mkdirSync(join(repositoryPath, "test", "math"), { recursive: true });
    writeFileSync(
      join(repositoryPath, "test", "math", "validate.test.cjs"),
      VALIDATE_TEST,
    );
    const run = async (args: readonly string[]): Promise<string> => {
      const result = await runner.run({ executable: "git", args, cwd: repositoryPath });
      if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
        throw new Error(`fixture git command failed: git ${args.join(" ")}: ${result.stderr}`);
      }
      return result.stdout;
    };
    await run(["init"]);
    await run(["config", "user.email", "runner@example.com"]);
    await run(["config", "user.name", "Agentic Runner Fixture"]);
    await run(["config", "core.autocrlf", "false"]);
    await run(["add", "."]);
    await run(["commit", "-m", "initial commit"]);
  }

  async function services() {
    const appServices = await createAppServices(
      {
        projectRoot: repositoryPath,
        stateDir,
        agentTimeoutMs: 60_000,
      },
      {
        agent: new OpenCodeAdapter(runner, {
          executable: process.execPath,
          launcherArgs: [FAKE_AGENT_SCRIPT],
        }),
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
  }

  async function openRepositoryStore(): Promise<RunnerStore> {
    const seeded = createSqliteRunnerStore({
      path: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
    });
    await seeded.initialize();
    return seeded;
  }

  it("runs the manually seeded task to DONE through agentic init/run/status/inspect", async () => {
    const services0 = services();

    const initIo = captureIo();
    expect(await runCli(["init"], { io: initIo.io, servicesFactory: async () => services0 })).toBe(0);

    store = await openRepositoryStore();
    await store.putTask(manualTask());
    await store.close();
    store = undefined;

    const runIo = captureIo();
    const serviceForRun = services();
    expect(await runCli(["run", TASK_ID], { io: runIo.io, servicesFactory: async () => serviceForRun })).toBe(0);
    expect(runIo.lines.join("\n")).toContain("completed");

    const statusIo = captureIo();
    const serviceForStatus = services();
    expect(await runCli(["status"], { io: statusIo.io, servicesFactory: async () => serviceForStatus })).toBe(0);
    expect(statusIo.lines.join("\n")).toContain("[DONE]");

    const inspectIo = captureIo();
    const serviceForInspect = services();
    expect(await runCli(["inspect", TASK_ID], { io: inspectIo.io, servicesFactory: async () => serviceForInspect })).toBe(0);
    const inspectOutput = inspectIo.lines.join("\n");
    expect(inspectOutput).toContain("status: DONE");
    expect(inspectOutput).toContain("integration.completed");

    const reopened = await openRepositoryStore();
    store = reopened;
    expect((await reopened.getTask(TASK_ID))?.status).toBe("DONE");
    const attempts = await reopened.listAttempts({ taskId: TASK_ID });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("SUCCEEDED");
    expect((await reopened.listEvents({ taskId: TASK_ID })).length).toBeGreaterThan(0);

    expect(readFileSync(join(repositoryPath, CLAMP_SOURCE), "utf8")).toContain(
      "module.exports = { clamp };",
    );
    expect(readFileSync(join(repositoryPath, CLAMP_TEST), "utf8")).toContain(
      'require("../../src/math/clamp.cjs")',
    );
    const gitStatus = await runner.run({
      executable: "git",
      args: ["status", "--porcelain"],
      cwd: repositoryPath,
    });
    expect(gitStatus.stdout.trim()).toBe("");
  }, 60_000);
});
