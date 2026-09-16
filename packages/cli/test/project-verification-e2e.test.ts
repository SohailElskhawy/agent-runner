import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentDescriptor,
  AgentExecutionResult,
  AgentInvocation,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import { ORCHESTRATION_EVENTS } from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createAppServices } from "../src/application/app-services.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { runCli } from "../src/run-cli.js";
import { captureIo, createFixtureTask, temporaryDirectory } from "./fixtures.js";

const TASK_ID = "M001";
const WORKDIR_MARKER = "workdir-marker.txt";
const PROJECT_ID = "proj-local";

const VALIDATE_SOURCE = [
  "function isFiniteNumber(value) {",
  '  return typeof value === "number" && Number.isFinite(value);',
  "}",
  "",
  "module.exports = { isFiniteNumber };",
  "",
].join("\n");

const UNIT_TEST = [
  'const test = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const { isFiniteNumber } = require("../src/validate.cjs");',
  "",
  'test("isFiniteNumber accepts finite numbers", () => {',
  "  assert.equal(isFiniteNumber(1), true);",
  "});",
  "",
].join("\n");

const VERIFY_WORKDIR_SCRIPT = [
  'import { readFileSync } from "node:fs";',
  "",
  'readFileSync("workdir-marker.txt", "utf8");',
  "",
].join("\n");

const ARG_FORWARD_SCRIPT =
  "process.exit(process.argv[1] === 'sentinel' ? 0 : 5)";

const CANONICAL_PROJECT_CONFIG = [
  "verification:",
  "  checks:",
  "    typecheck:",
  "      command: node",
  "      args:",
  "        - --check",
  "        - src/validate.cjs",
  "    unit:",
  "      command: node",
  "      args:",
  "        - --test",
  "        - test/unit.test.cjs",
  "    workdir:",
  "      command: node",
  "      args:",
  "        - scripts/verify-workdir.mjs",
  "    argforward:",
  "      command: node",
  "      args:",
  "        - -e",
  `        - "${ARG_FORWARD_SCRIPT}"`,
  "        - sentinel",
  "    failcheck:",
  "      command: node",
  "      args:",
  "        - -e",
  "        - process.exit(3)",
  "",
].join("\n");

type StoredCheckResult = {
  readonly id: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly command: readonly string[];
  readonly outcome: string;
  readonly exitCode?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
};

type StoredVerificationPayload = {
  readonly attemptId: string;
  readonly status: string;
  readonly checks: readonly StoredCheckResult[];
};

class MarkerAgentRuntime implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "marker-agent" };

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    writeFileSync(
      join(invocation.worktreePath, WORKDIR_MARKER),
      "marker\n",
      "utf8",
    );
    return {
      kind: "success",
      output: { stdout: "ok" },
      exitCode: 0,
      durationMs: 1,
    };
  }
}

describe("M057a project-configured verification checks", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let runner: ProcessRunner;
  let store: RunnerStore | undefined;

  beforeEach(() => {
    directory = temporaryDirectory("agentic-runner-m057a-");
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
    configYaml: string | undefined,
  ): Promise<void> {
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(
      join(repositoryPath, "AGENTS.md"),
      "# Fixture rules\n\nBe precise.\n",
      "utf8",
    );
    writeFileSync(join(repositoryPath, "README.md"), "fixture\n", "utf8");
    mkdirSync(join(repositoryPath, "src"), { recursive: true });
    writeFileSync(join(repositoryPath, "src", "validate.cjs"), VALIDATE_SOURCE, "utf8");
    mkdirSync(join(repositoryPath, "test"), { recursive: true });
    writeFileSync(join(repositoryPath, "test", "unit.test.cjs"), UNIT_TEST, "utf8");
    mkdirSync(join(repositoryPath, "scripts"), { recursive: true });
    writeFileSync(
      join(repositoryPath, "scripts", "verify-workdir.mjs"),
      VERIFY_WORKDIR_SCRIPT,
      "utf8",
    );
    if (configYaml !== undefined) {
      writeFileSync(join(repositoryPath, "agentic.yaml"), configYaml, "utf8");
    }
    const run = async (args: readonly string[]): Promise<void> => {
      const result = await runner.run({
        executable: "git",
        args,
        cwd: repositoryPath,
      });
      if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
        throw new Error(`fixture git command failed: git ${args.join(" ")}: ${result.stderr}`);
      }
    };
    await run(["init"]);
    await run(["config", "user.email", "runner@example.com"]);
    await run(["config", "user.name", "Agentic Runner Tests"]);
    await run(["config", "core.autocrlf", "false"]);
    await run(["add", "."]);
    await run(["commit", "-m", "initial commit"]);
  }

  async function openRepositoryStore(): Promise<RunnerStore> {
    const opened = createSqliteRunnerStore({
      path: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
    });
    await opened.initialize();
    return opened;
  }

  async function seedTask(required: readonly string[]): Promise<void> {
    const seeded = await openRepositoryStore();
    store = seeded;
    await seeded.putProject({
      id: PROJECT_ID,
      name: "m057a-fixture",
      rootPath: repositoryPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const task = createFixtureTask({ id: TASK_ID, projectId: PROJECT_ID });
    await seeded.putTask({
      ...task,
      definition: {
        ...task.definition,
        verification: { required: [...required] },
      },
    });
    await seeded.close();
    store = undefined;
  }

  function buildService(agent: AgentRuntime) {
    return async () => {
      const appServices = await createAppServices(
        {
          projectRoot: repositoryPath,
          stateDir,
          agentTimeoutMs: 60_000,
        },
        { agent },
      );
      return createStoreBackedAppService({
        storePath: resolveStorePath({ projectRoot: repositoryPath, stateDir }),
        projectRoot: repositoryPath,
        store: appServices.store,
        orchestrator: appServices.orchestrator,
        recovery: appServices.recovery,
        agents: appServices.agents,
      });
    };
  }

  async function runTask(): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    const { io, lines, errors } = captureIo();
    const exitCode = await runCli(["run", TASK_ID], {
      io,
      servicesFactory: buildService(new MarkerAgentRuntime()),
    });
    return { exitCode, stdout: lines.join("\n"), stderr: errors.join("\n") };
  }

  async function readState(taskId = TASK_ID) {
    const opened = await openRepositoryStore();
    store = opened;
    const task = await opened.getTask(taskId);
    const attempts = await opened.listAttempts({ taskId });
    const events = await opened.listEvents({ taskId });
    return { task, attempts, events };
  }

  function latestVerificationPayload(
    events: readonly { readonly type: string; readonly payload: unknown }[],
  ): StoredVerificationPayload | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== ORCHESTRATION_EVENTS.verificationCompleted) {
        continue;
      }
      return event.payload as StoredVerificationPayload;
    }
    return undefined;
  }

  it("executes one configured required check successfully and integrates", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["typecheck"]);

    const result = await runTask();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("completed");

    const { task, attempts, events } = await readState();
    expect(task?.status).toBe("DONE");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("SUCCEEDED");
    const payload = latestVerificationPayload(events);
    expect(payload?.status).toBe("PASSED");
    expect(payload?.checks).toEqual([
      {
        id: expect.any(String),
        attemptId: "att_M001_1",
        kind: "typecheck",
        command: ["node", "--check", "src/validate.cjs"],
        outcome: "PASSED",
        exitCode: 0,
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      },
    ]);
  });

  it("executes multiple checks in the task-declared order, not configuration order", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["unit", "typecheck"]);

    const result = await runTask();

    expect(result.exitCode).toBe(0);
    const { task, events } = await readState();
    expect(task?.status).toBe("DONE");
    const payload = latestVerificationPayload(events);
    expect(payload?.checks?.map((check) => check.kind)).toEqual([
      "unit",
      "typecheck",
    ]);
    expect(payload?.checks?.map((check) => check.command)).toEqual([
      ["node", "--test", "test/unit.test.cjs"],
      ["node", "--check", "src/validate.cjs"],
    ]);
  });

  it("passes configured command arguments to the executed process", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["argforward"]);

    const result = await runTask();

    expect(result.exitCode).toBe(0);
    const { task, events } = await readState();
    expect(task?.status).toBe("DONE");
    const payload = latestVerificationPayload(events);
    expect(payload?.checks?.[0]?.outcome).toBe("PASSED");
    expect(payload?.checks?.[0]?.exitCode).toBe(0);
  });

  it("executes configured commands in the task worktree", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["workdir"]);

    const result = await runTask();

    expect(result.exitCode).toBe(0);
    const { task, events } = await readState();
    expect(task?.status).toBe("DONE");
    const payload = latestVerificationPayload(events);
    expect(payload?.checks?.[0]?.outcome).toBe("PASSED");
  });

  it("a failed configured check prevents integration", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["typecheck", "failcheck"]);

    const result = await runTask();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'verification command "failcheck" exited with code 3',
    );

    const { task, attempts, events } = await readState();
    expect(task?.status).toBe("FAILED");
    expect(attempts.at(-1)?.failure?.kind).toBe("verification_failed");
    const payload = latestVerificationPayload(events);
    expect(payload?.status).toBe("FAILED");
    const failedCheck = payload?.checks?.find(
      (check) => check.outcome === "FAILED",
    );
    expect(failedCheck?.exitCode).toBe(3);
    expect(events.some((event) => event.type === ORCHESTRATION_EVENTS.commitCreated)).toBe(
      false,
    );
    expect(
      events.some((event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted),
    ).toBe(false);
  });

  it("an unknown required check fails clearly before integration", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["lint"]);

    const result = await runTask();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("rejected");
    expect(result.stderr).toContain("no verification command configured");
    expect(result.stderr).toContain("lint");

    const { task, attempts, events } = await readState();
    expect(task?.status).toBe("READY");
    expect(attempts).toHaveLength(0);
    expect(
      events.some((event) => event.type === ORCHESTRATION_EVENTS.verificationCompleted),
    ).toBe(false);
  });

  it("an absent project configuration fails clearly", async () => {
    await createFixtureRepository(undefined);
    await seedTask(["typecheck"]);

    const result = await runTask();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("project configuration could not be loaded");
    expect(result.stderr).toContain("agentic.yaml is missing");
  });

  it("an unparseable project configuration fails clearly", async () => {
    await createFixtureRepository("verification:\n  checks:\n  [command: pnpm\n");
    await seedTask(["typecheck"]);

    const result = await runTask();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("parsing agentic.yaml failed");
  });

  it("a schema-invalid project configuration fails clearly", async () => {
    await createFixtureRepository(
      `${CANONICAL_PROJECT_CONFIG}agents:\n  default: opencode\n`,
    );
    await seedTask(["typecheck"]);

    const result = await runTask();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agentic.yaml is invalid");
    expect(result.stderr).toContain('unknown field "agents"');
  });

  it("verification evidence remains persisted and inspectable", async () => {
    await createFixtureRepository(CANONICAL_PROJECT_CONFIG);
    await seedTask(["typecheck", "unit"]);

    const result = await runTask();
    expect(result.exitCode).toBe(0);

    const inspectIo = captureIo();
    const inspectExit = await runCli(["inspect", TASK_ID], {
      io: inspectIo.io,
      servicesFactory: buildService(new MarkerAgentRuntime()),
    });
    expect(inspectExit).toBe(0);
    expect(inspectIo.lines.join("\n")).toContain("verification.completed");

    const { events } = await readState();
    const payload = latestVerificationPayload(events);
    expect(payload?.status).toBe("PASSED");
    expect(payload?.checks?.map((check) => check.kind)).toEqual([
      "typecheck",
      "unit",
    ]);
    expect(payload?.checks?.map((check) => check.outcome)).toEqual([
      "PASSED",
      "PASSED",
    ]);
  });
});
