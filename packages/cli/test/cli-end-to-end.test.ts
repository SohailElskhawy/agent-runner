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
  createFixtureAttempt,
  createFixtureRepository,
  createFixtureTask,
  RecordingAgentRuntime,
  PassingVerificationEngine,
  temporaryDirectory,
  writeProjectConfiguration,
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
  let fixtureHeadRevision: string;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = temporaryDirectory("agentic-cli-e2e");
    repositoryPath = join(directory, "my project repo");
    stateDirectory = defaultStateDir(repositoryPath);
    fixtureHeadRevision = await createFixtureRepository(repositoryPath, AGENTS_MARKDOWN);
  });

  afterEach(async () => {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
  });

  async function servicesForRepository(agent: RecordingAgentRuntime) {
    const appServices = await createAppServices({
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
      agents: appServices.agents,
    });
  }

  async function defaultWiredServices() {
    writeProjectConfiguration(repositoryPath, [
      "verification:",
      "  checks:",
      "    build:",
      "      command: node",
      "      args:",
      "        - --version",
      "",
    ].join("\n"));
    const appServices = await createAppServices({
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
      agents: appServices.agents,
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

  it("grants approval for an approval-required task and surfaces it in status and inspect", async () => {
    const { io: initIo } = captureIo();
    const initExit = await runCli(["init"], { io: initIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(initExit).toBe(0);

    store = await openRepositoryStore();
    await store.putTask(createFixtureTask({ projectId: "proj-local", approvalRequired: true }));
    await store.close();
    store = undefined;

    const { io: statusIo, lines: statusLines } = captureIo();
    const statusExit = await runCli(["status"], { io: statusIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(statusExit).toBe(0);
    expect(statusLines.join("\n")).toContain("M001 [READY] Add a small utility function [approval required]");

    const { io: inspectIo, lines: inspectLines } = captureIo();
    const inspectExit = await runCli(["inspect", "M001"], { io: inspectIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(inspectExit).toBe(0);
    expect(inspectLines.join("\n")).toContain("approval: required, granted at pending");

    const { io: approveIo, lines: approveLines, errors: approveErrors } = captureIo();
    const approveExit = await runCli(["approve", "M001"], { io: approveIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(approveExit).toBe(0);
    expect(approveLines.join("\n")).toContain('approval granted for task "M001"');
    expect(approveErrors).toHaveLength(0);

    store = await openRepositoryStore();
    const grantedTask = await store.getTask("M001");
    expect(grantedTask?.approvalGrantedAt).toBeTypeOf("string");
    expect(
      (await store.listEvents({ taskId: "M001", type: "task.approval.granted" })).length,
    ).toBe(1);
    await store.close();
    store = undefined;

    const { io: grantedInspectIo, lines: grantedInspectLines } = captureIo();
    const grantedInspectExit = await runCli(["inspect", "M001"], { io: grantedInspectIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(grantedInspectExit).toBe(0);
    expect(grantedInspectLines.join("\n")).toMatch(
      /approval: required, granted at \d{4}-\d{2}-\d{2}T/,
    );

    const { io: grantedStatusIo, lines: grantedStatusLines } = captureIo();
    const grantedStatusExit = await runCli(["status"], { io: grantedStatusIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(grantedStatusExit).toBe(0);
    expect(grantedStatusLines.join("\n")).not.toContain("[approval required]");

    const { io: againIo, lines: againLines, errors: againErrors } = captureIo();
    const againExit = await runCli(["approve", "M001"], { io: againIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(againExit).toBe(0);
    expect(againLines.join("\n")).toContain('task "M001" was already approved at');
    expect(againErrors).toHaveLength(0);
  });

  it("rejects approve for a task that does not require approval", async () => {
    const { io: initIo } = captureIo();
    const initExit = await runCli(["init"], { io: initIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(initExit).toBe(0);

    store = await openRepositoryStore();
    await store.putTask(createFixtureTask({ projectId: "proj-local" }));
    await store.close();
    store = undefined;

    const { io, errors } = captureIo();
    const exitCode = await runCli(["approve", "M001"], { io, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('task "M001" does not require human approval');
  });

  it("reconciles an interrupted task on startup so status and inspect observe reconciled state", async () => {
    const { io: initIo } = captureIo();
    const initExit = await runCli(["init"], { io: initIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(initExit).toBe(0);

    store = await openRepositoryStore();
    await store.putTask(createFixtureTask({ status: "IMPLEMENTING" }));
    await store.putAttempt(
      createFixtureAttempt({ status: "RUNNING", baseRevision: fixtureHeadRevision }),
    );
    await store.close();
    store = undefined;

    const interruptedAgent = new RecordingAgentRuntime();
    const { io: statusIo, lines: statusLines } = captureIo();
    const statusExit = await runCli(["status"], { io: statusIo, servicesFactory: () => servicesForRepository(interruptedAgent) });
    expect(statusExit).toBe(0);
    const statusOutput = statusLines.join("\n");
    expect(statusOutput).toContain("M001 [READY]");
    expect(statusOutput).not.toContain("[IMPLEMENTING]");
    expect(interruptedAgent.invocations).toHaveLength(0);

    store = await openRepositoryStore();
    expect((await store.getTask("M001"))?.status).toBe("READY");
    const attempts = await store.listAttempts({ taskId: "M001" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("FAILED");
    const events = await store.listEvents({ taskId: "M001" });
    expect(events.some((event) => event.type === "recovery.reconciled")).toBe(true);
    await store.close();
    store = undefined;

    const { io: inspectIo, lines: inspectLines } = captureIo();
    const inspectExit = await runCli(["inspect", "M001"], { io: inspectIo, servicesFactory: () => servicesForRepository(new RecordingAgentRuntime()) });
    expect(inspectExit).toBe(0);
    const inspectOutput = inspectLines.join("\n");
    expect(inspectOutput).toContain("status: READY");
    expect(inspectOutput).toContain("recovery.reconciled");
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
    const services = await defaultWiredServices();

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
