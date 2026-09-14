import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { runCli } from "../src/run-cli.js";
import { createAppServices } from "../src/application/app-services.js";
import {
  defaultStateDir,
  resolveStorePath,
} from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import {
  captureIo,
  createFixtureRepository,
  createFixtureTask,
  RecordingAgentRuntime,
  PassingVerificationEngine,
  temporaryDirectory,
} from "./fixtures.js";

const AGENTS_MARKDOWN = "# Fixture rules\n\nBe precise.\n";

const EXPLICIT_VERIFICATION_CHECKS = [
  { name: "typecheck", executable: "node", args: ["--version"] },
  { name: "unit", executable: "node", args: ["--version"] },
] as const;

describe("CLI end-to-end over a repository with spaces in its path", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDirectory: string;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = temporaryDirectory("agentic-cli-e2e");
    repositoryPath = join(directory, "my project repo");
    stateDirectory = defaultStateDir(repositoryPath);
    await createFixtureRepository(repositoryPath, AGENTS_MARKDOWN);
  });

  afterEach(async () => {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
  });

  function servicesForRepository(agent: RecordingAgentRuntime) {
    const appServices = createAppServices({
      projectRoot: repositoryPath,
      stateDir: stateDirectory,
      verificationChecks: EXPLICIT_VERIFICATION_CHECKS,
    }, {
      agent,
      verification: new PassingVerificationEngine(),
    });
    return createStoreBackedAppService({
      storePath: resolveStorePath({ projectRoot: repositoryPath, stateDir: stateDirectory }),
      projectRoot: repositoryPath,
      store: appServices.store,
      orchestrator: appServices.orchestrator,
      recovery: appServices.recovery,
    });
  }

  function defaultWiredServices() {
    const appServices = createAppServices({
      projectRoot: repositoryPath,
      stateDir: stateDirectory,
    }, {
      agent: new RecordingAgentRuntime(),
      verification: new PassingVerificationEngine(),
    });
    return createStoreBackedAppService({
      storePath: resolveStorePath({ projectRoot: repositoryPath, stateDir: stateDirectory }),
      projectRoot: repositoryPath,
      store: appServices.store,
      orchestrator: appServices.orchestrator,
      recovery: appServices.recovery,
    });
  }

  async function openRepositoryStore(): Promise<RunnerStore> {
    const seeded = createSqliteRunnerStore({
      path: resolveStorePath({ projectRoot: repositoryPath, stateDir: stateDirectory }),
    });
    await seeded.initialize();
    return seeded;
  }

  it("init persists runner state idempotently", async () => {
    const { io, lines } = captureIo();
    const first = await runCli(["init"], { io, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(first).toBe(0);
    expect(lines.join("\n")).toContain("my project repo");

    const second = await runCli(["init"], { io, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(second).toBe(0);

    store = await openRepositoryStore();
    const projects = await store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.rootPath).toBe(repositoryPath);
  });

  it("runs a manually seeded task to completion and shows persisted evidence", async () => {
    const agent = new RecordingAgentRuntime();
    const { io } = captureIo();
    const services = servicesForRepository(agent);

    const initExit = await runCli(["init"], { io, servicesFactory: async () => services });
    expect(initExit).toBe(0);

    store = await openRepositoryStore();
    await store.putTask(createFixtureTask({ projectId: "proj-local" }));
    await store.close();
    store = undefined;

    const { io: runIo, lines: runLines } = captureIo();
    const runExit = await runCli(["run", "M001"], { io: runIo, servicesFactory: async () => services });
    expect(runExit).toBe(0);
    expect(agent.invocations).toHaveLength(1);
    expect(runLines.join("\n")).toContain("completed");

    const { io: statusIo, lines: statusLines } = captureIo();
    const statusExit = await runCli(["status"], { io: statusIo, servicesFactory: async () => services });
    expect(statusExit).toBe(0);
    expect(statusLines.join("\n")).toContain("[DONE]");

    const { io: inspectIo, lines: inspectLines } = captureIo();
    const inspectExit = await runCli(["inspect", "M001"], { io: inspectIo, servicesFactory: async () => services });
    expect(inspectExit).toBe(0);
    const inspectOutput = inspectLines.join("\n");
    expect(inspectOutput).toContain("status: DONE");
    expect(inspectOutput).toContain("task.transitioned");
    expect(inspectOutput).toContain("integration.completed");
  });

  it("exits non-zero when a task is unknown", async () => {
    const { io, errors } = captureIo();
    const services = servicesForRepository(new RecordingAgentRuntime());

    const runExit = await runCli(["run", "M999"], { io, servicesFactory: async () => services });
    expect(runExit).toBe(1);
    expect(errors.join("\n")).toContain("rejected");
  });

  it("rejects tasks whose required verification checks have no configured command", async () => {
    const { io } = captureIo();
    const services = defaultWiredServices();

    const initExit = await runCli(["init"], { io, servicesFactory: async () => services });
    expect(initExit).toBe(0);

    store = await openRepositoryStore();
    await store.putTask(createFixtureTask({ projectId: "proj-local" }));
    await store.close();
    store = undefined;

    const { io: runIo, errors: runErrors } = captureIo();
    const runExit = await runCli(["run", "M001"], { io: runIo, servicesFactory: async () => services });
    expect(runExit).toBe(1);
    const stderr = runErrors.join("\n");
    expect(stderr).toContain("rejected");
    expect(stderr).toContain("no verification command configured");
    expect(stderr).toContain("typecheck");
    expect(stderr).not.toContain("pnpm");
  });
});
