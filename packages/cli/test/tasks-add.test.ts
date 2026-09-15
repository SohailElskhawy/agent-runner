import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskId } from "@agentic-dev-runner/core";
import type {
  CrashRecovery,
  RecoveryOutcome,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { runCli } from "../src/run-cli.js";
import type { RunnerAppService } from "../src/application/runner-app-service.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { captureIo, temporaryDirectory } from "./fixtures.js";

class StubOrchestrator implements SingleTaskOrchestrator {
  async run(taskId: TaskId): Promise<SingleTaskRunOutcome> {
    throw new Error(`orchestrator must not run in tasks add tests: ${taskId}`);
  }
}

class StubRecovery implements CrashRecovery {
  async reconcileTask(taskId: TaskId): Promise<RecoveryOutcome> {
    return { kind: "no-op", taskId, detail: "stub recovery" };
  }

  async reconcileUnfinished(): Promise<RecoveryOutcome[]> {
    return [];
  }
}

function validTaskFileContent(): Record<string, unknown> {
  return {
    id: "M070",
    title: "Add manual task ingestion",
    milestone: "cli-product-experience",
    status: "READY",
    priority: "P1",
    risk: "low",
    type: "implementation",
    objective: "Allow developers to add manually defined tasks to the runner.",
    acceptanceCriteria: [
      "A valid JSON task file is parsed, validated, and persisted.",
    ],
    dependsOn: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: {
      allowedPaths: ["packages/cli/**"],
      forbiddenPaths: ["docs/**"],
    },
    resources: ["task-ingestion"],
    workflow: "default",
    routing: { complexity: "small", capabilities: ["typescript"] },
    verification: { required: ["typecheck", "unit"] },
    limits: { maxAttempts: 3, maxReviewCycles: 2 },
    approval: { required: false },
  };
}

describe("agentic tasks add", () => {
  let directory: string;
  let storePath: string;

  beforeEach(() => {
    directory = temporaryDirectory("agentic-tasks-add");
    storePath = join(directory, "state.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function writeTaskFile(
    content: unknown,
    name = "M070.json",
  ): string {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(content, null, 2), "utf8");
    return path;
  }

  function wiredServices(): RunnerAppService {
    return createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store: createSqliteRunnerStore({ path: storePath }),
      orchestrator: new StubOrchestrator(),
      recovery: new StubRecovery(),
    });
  }

  async function openStore(): Promise<RunnerStore> {
    const store = createSqliteRunnerStore({ path: storePath });
    await store.initialize();
    return store;
  }

  function storeWithFailingPutTask(): RunnerStore {
    const base = createSqliteRunnerStore({ path: storePath });
    return Object.assign(Object.create(base) as RunnerStore, {
      putTask: async (): Promise<void> => {
        throw new Error("disk is full");
      },
    });
  }

  it("persists a valid task file and reports it", async () => {
    const taskFile = writeTaskFile(validTaskFileContent());
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, lines } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain('task "M070" added');

    const store = await openStore();
    try {
      const task = await store.getTask("M070");
      expect(task?.projectId).toBe("proj-local");
      expect(task?.title).toBe("Add manual task ingestion");
      expect(task?.status).toBe("READY");
      expect(task?.definition.acceptanceCriteria).toEqual([
        "A valid JSON task file is parsed, validated, and persisted.",
      ]);
      expect(task?.definition.limits).toEqual({
        maxAttempts: 3,
        maxReviewCycles: 2,
      });
      expect(task?.provenance).toEqual({ kind: "user_request", source: "manual" });
    } finally {
      await store.close();
    }
  });

  it("makes the added task visible to status and inspect", async () => {
    const taskFile = writeTaskFile(validTaskFileContent());
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);
    const { io: addIo } = captureIo();
    expect(
      await runCli(["tasks", "add", taskFile], {
        io: addIo,
        servicesFactory: () => wiredServices(),
      }),
    ).toBe(0);

    const { io: statusIo, lines: statusLines } = captureIo();
    const statusExit = await runCli(["status"], {
      io: statusIo,
      servicesFactory: () => wiredServices(),
    });
    expect(statusExit).toBe(0);
    expect(statusLines.join("\n")).toContain("M070");
    expect(statusLines.join("\n")).toContain("[READY]");

    const { io: inspectIo, lines: inspectLines } = captureIo();
    const inspectExit = await runCli(["inspect", "M070"], {
      io: inspectIo,
      servicesFactory: () => wiredServices(),
    });
    expect(inspectExit).toBe(0);
    const inspectOutput = inspectLines.join("\n");
    expect(inspectOutput).toContain("task: M070");
    expect(inspectOutput).toContain("title: Add manual task ingestion");
    expect(inspectOutput).toContain("status: READY");
  });

  it("rejects duplicate task IDs without overwriting the original task", async () => {
    const taskFile = writeTaskFile(validTaskFileContent());
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);
    const { io: addIo } = captureIo();
    expect(
      await runCli(["tasks", "add", taskFile], {
        io: addIo,
        servicesFactory: () => wiredServices(),
      }),
    ).toBe(0);

    const changedTaskFile = writeTaskFile(
      { ...validTaskFileContent(), title: "Overwrite attempt" },
      "M070-changed.json",
    );
    const { io, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", changedTaskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(1);
    const stderr = errors.join("\n");
    expect(stderr).toContain('task "M070" already exists');
    expect(stderr).not.toContain("    at ");

    const store = await openStore();
    try {
      const task = await store.getTask("M070");
      expect(task?.title).toBe("Add manual task ingestion");
      expect((await store.listTasks())).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("rejects malformed JSON", async () => {
    const taskFile = join(directory, "broken.json");
    writeFileSync(taskFile, '{ "id": "M070", ', "utf8");
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("is not valid JSON");
  });

  it("rejects missing required fields", async () => {
    const content = validTaskFileContent();
    delete content["title"];
    const taskFile = writeTaskFile(content);
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("task definition.title:");
  });

  it("rejects invalid enum and domain values", async () => {
    const taskFile = writeTaskFile({
      ...validTaskFileContent(),
      risk: "extreme",
    });
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("task definition.risk:");
  });

  it("rejects initial statuses that are not appropriate for manually added tasks", async () => {
    const taskFile = writeTaskFile({
      ...validTaskFileContent(),
      status: "IMPLEMENTING",
    });
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("BACKLOG or READY");
  });

  it("rejects task files that do not exist", async () => {
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, errors } = captureIo();
    const exitCode = await runCli(
      ["tasks", "add", join(directory, "missing.json")],
      { io, servicesFactory: () => wiredServices() },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("does not exist");
  });

  it("rejects an uninitialized runner without creating implicit project state", async () => {
    const taskFile = writeTaskFile(validTaskFileContent());
    const { io, errors } = captureIo();

    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(1);
    const stderr = errors.join("\n");
    expect(stderr).toContain("runner is not initialized");
    expect(stderr).not.toContain("    at ");

    const store = await openStore();
    try {
      expect(await store.listProjects()).toHaveLength(0);
      expect(await store.listTasks()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("supports task file paths containing spaces", async () => {
    const spacedDirectory = join(directory, "my task files");
    mkdirSync(spacedDirectory, { recursive: true });
    const taskFile = join(spacedDirectory, "M070.json");
    writeFileSync(taskFile, JSON.stringify(validTaskFileContent(), null, 2), "utf8");
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const { io, lines } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => wiredServices(),
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain('task "M070" added');

    const store = await openStore();
    try {
      expect((await store.getTask("M070"))?.title).toBe(
        "Add manual task ingestion",
      );
    } finally {
      await store.close();
    }
  });

  it("surfaces persistence failures cleanly without persisting the task", async () => {
    const taskFile = writeTaskFile(validTaskFileContent());
    const { io: initIo } = captureIo();
    expect(
      await runCli(["init"], { io: initIo, servicesFactory: () => wiredServices() }),
    ).toBe(0);

    const failingServices = createStoreBackedAppService({
      storePath,
      projectRoot: directory,
      store: storeWithFailingPutTask(),
      orchestrator: new StubOrchestrator(),
      recovery: new StubRecovery(),
    });
    const { io, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", taskFile], {
      io,
      servicesFactory: () => failingServices,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("disk is full");
    expect(errors.join("\n")).not.toContain("    at ");

    const store = await openStore();
    try {
      expect(await store.listTasks()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("delegates to the application service instead of persistence", async () => {
    const addCalls: string[] = [];
    const service: RunnerAppService = {
      async init() {
        return {
          projectId: "proj-local",
          projectRoot: "fixture",
          storePath: "fixture/state.db",
        };
      },
      async addTask(taskFilePath: string) {
        addCalls.push(taskFilePath);
        return {
          taskId: "M001",
          projectId: "proj-local",
          title: "Add a small utility function",
          status: "READY",
        };
      },
      async run() {
        throw new Error("run must not be called");
      },
      async status() {
        throw new Error("status must not be called");
      },
      async inspect() {
        throw new Error("inspect must not be called");
      },
      async close() {
        return;
      },
    };

    const { io, lines, errors } = captureIo();
    const exitCode = await runCli(["tasks", "add", "./tasks/M001.json"], {
      io,
      servicesFactory: () => service,
    });

    expect(exitCode).toBe(0);
    expect(addCalls).toEqual(["./tasks/M001.json"]);
    expect(lines.join("\n")).toContain('task "M001" added');
    expect(errors).toHaveLength(0);
  });

  it("rejects malformed command lines with usage output", async () => {
    const missingSubcommand = captureIo();
    expect(
      await runCli(["tasks"], {
        io: missingSubcommand.io,
        servicesFactory: () => wiredServices(),
      }),
    ).toBe(2);
    expect(missingSubcommand.errors.join("\n")).toContain(
      'command "tasks" requires a subcommand',
    );

    const unknownSubcommand = captureIo();
    expect(
      await runCli(["tasks", "edit", "file.json"], {
        io: unknownSubcommand.io,
        servicesFactory: () => wiredServices(),
      }),
    ).toBe(2);
    expect(unknownSubcommand.errors.join("\n")).toContain(
      'unknown tasks subcommand "edit"',
    );

    const missingTaskFile = captureIo();
    expect(
      await runCli(["tasks", "add"], {
        io: missingTaskFile.io,
        servicesFactory: () => wiredServices(),
      }),
    ).toBe(2);
    expect(missingTaskFile.errors.join("\n")).toContain(
      'command "tasks add" requires a <task-file> argument',
    );

    const extraArguments = captureIo();
    expect(
      await runCli(["tasks", "add", "a.json", "b.json"], {
        io: extraArguments.io,
        servicesFactory: () => wiredServices(),
      }),
    ).toBe(2);
    expect(extraArguments.errors.join("\n")).toContain(
      'command "tasks add" accepts exactly one <task-file> argument',
    );
  });
});
