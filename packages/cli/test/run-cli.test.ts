import { describe, expect, it } from "vitest";
import type { TaskId } from "@agentic-dev-runner/core";
import type { RunnerAppService } from "../src/application/runner-app-service.js";
import { runCli } from "../src/run-cli.js";
import type {
  AddTaskResult,
  AgentStatusEntry,
  InitResult,
  ProjectStatus,
  RunResult,
  TaskInspection,
} from "../src/application/ports.js";
import { captureIo, createFixtureProject, createFixtureTask } from "./fixtures.js";

type RunSpy = { calls: readonly TaskId[] };
type UnattendedRunSpy = { calls: readonly { maxParallelism?: number | undefined }[] };

function recordingService(result: {
  init?: InitResult;
  add?: AddTaskResult;
  addFailure?: Error;
  run?: RunResult;
  unattended?: RunResult;
  status?: ProjectStatus;
  inspection?: TaskInspection | null;
  agents?: readonly AgentStatusEntry[];
  failure?: Error;
}): {
  service: RunnerAppService;
  runCalls: RunSpy;
  unattendedCalls: UnattendedRunSpy;
  initCalls: { count: number };
  addCalls: { calls: string[] };
  listAgentsCalls: { count: number };
} {
  const runCalls: string[] = [];
  const unattendedCalls: { maxParallelism?: number | undefined }[] = [];
  const addCalls: string[] = [];
  let initCount = 0;
  let listAgentsCount = 0;
  const service: RunnerAppService = {
    async init() {
      initCount += 1;
      if (result.failure !== undefined) {
        throw result.failure;
      }
      return (
        result.init ?? {
          projectId: "proj-local",
          projectRoot: "fixture",
          storePath: "fixture/state.db",
        }
      );
    },
    async addTask(taskFilePath: string) {
      addCalls.push(taskFilePath);
      if (result.addFailure !== undefined) {
        throw result.addFailure;
      }
      return (
        result.add ?? {
          taskId: "M001",
          projectId: "proj-local",
          title: "Add a small utility function",
          status: "READY",
        }
      );
    },
    async run(taskId: TaskId) {
      runCalls.push(taskId);
      if (result.failure !== undefined) {
        throw result.failure;
      }
      return (
        result.run ?? {
          kind: "completed",
          message: `task "${taskId}" completed`,
        }
      );
    },
    async runUnattended(options) {
      unattendedCalls.push(options ?? {});
      if (result.failure !== undefined) {
        throw result.failure;
      }
      return (
        result.unattended ?? {
          kind: "completed",
          message: "unattended completed",
        }
      );
    },
    async status() {
      return (
        result.status ?? {
          project: createFixtureProject(),
          tasks: [],
        }
      );
    },
    async inspect() {
      return result.inspection ?? null;
    },
    async listAgents() {
      listAgentsCount += 1;
      if (result.failure !== undefined) {
        throw result.failure;
      }
      return (
        result.agents ?? [
          { id: "opencode", available: true, version: "1.0.0", reason: null },
        ]
      );
    },
    async close() {
      return;
    },
  };
  return {
    service,
    runCalls: { calls: runCalls },
    unattendedCalls: { calls: unattendedCalls },
    addCalls: { calls: addCalls },
    initCalls: {
      get count() {
        return initCount;
      },
    },
    listAgentsCalls: {
      get count() {
        return listAgentsCount;
      },
    },
  };
}

describe("runCli command dispatch", () => {
  it("delegates exactly once to the application service on run and exits zero on success", async () => {
    const recording = recordingService({
      run: { kind: "completed", message: 'task "M001" completed' },
    });
    const { io, lines } = captureIo();

    const exitCode = await runCli(["run", "M001"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(0);
    expect(recording.runCalls.calls).toEqual(["M001"]);
    expect(lines.join("\n")).toContain('task "M001" completed');
  });

  it("delegates unattended execution to the application service on run-all", async () => {
    const recording = recordingService({
      unattended: { kind: "completed", message: "unattended completed" },
    });
    const { io, lines } = captureIo();

    const exitCode = await runCli(["run-all"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(0);
    expect(recording.unattendedCalls.calls).toEqual([{}]);
    expect(recording.runCalls.calls).toEqual([]);
    expect(lines.join("\n")).toContain("unattended completed");
  });

  it("starts unattended DAG execution when run has no task id", async () => {
    const recording = recordingService({
      unattended: { kind: "completed", message: "unattended completed" },
    });
    const { io } = captureIo();

    const exitCode = await runCli(["run"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(0);
    expect(recording.unattendedCalls.calls).toEqual([{}]);
    expect(recording.runCalls.calls).toEqual([]);
  });

  it("passes the parallel capacity option to the unattended application service", async () => {
    for (const [value, expected] of [
      ["1", 1],
      ["3", 3],
    ] as const) {
      const recording = recordingService({
        unattended: { kind: "completed", message: "unattended completed" },
      });
      const { io } = captureIo();

      const exitCode = await runCli(["run", "--parallel", value], {
        io,
        servicesFactory: async () => recording.service,
      });

      expect(exitCode).toBe(0);
      expect(recording.unattendedCalls.calls).toEqual([{ maxParallelism: expected }]);
    }
  });

  it("rejects invalid parallel values with usage code 2", async () => {
    for (const value of ["0", "-1", "abc", "2.5"]) {
      const recording = recordingService({});
      const { io, errors } = captureIo();

      const exitCode = await runCli(["run", "--parallel", value], {
        io,
        servicesFactory: async () => recording.service,
      });

      expect(exitCode).toBe(2);
      expect(recording.unattendedCalls.calls).toEqual([]);
      expect(errors.join("\n")).toContain("positive integer");
    }
  });

  it("exits non-zero for blocked unattended runs while reporting persisted state", async () => {
    const recording = recordingService({
      unattended: {
        kind: "failed",
        message:
          'unattended run reached quiescence after 2 cycle(s); final persisted task state: 1 DONE, 1 FAILED',
      },
    });
    const { io, errors } = captureIo();

    const exitCode = await runCli(["run"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("final persisted task state: 1 DONE, 1 FAILED");
  });

  it("exits non-zero for failed, cancelled, and rejected run outcomes", async () => {
    for (const kind of ["failed", "cancelled", "rejected"] as const) {
      const recording = recordingService({
        run: { kind, message: "task did not go well" },
      });
      const { io, errors } = captureIo();

      const exitCode = await runCli(["run", "M001"], {
        io,
        servicesFactory: async () => recording.service,
      });

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("task did not go well");
    }
  });

  it("renders run outcomes and maps exit codes without duplicating orchestration logic", async () => {
    const outcomes: Record<string, RunResult> = {
      completed: { kind: "completed", message: "done" },
      failed: { kind: "failed", message: "boom" },
      cancelled: { kind: "cancelled", message: "stop" },
      rejected: { kind: "rejected", message: "no" },
    };
    for (const [kind, run] of Object.entries(outcomes)) {
      const recording = recordingService({ run });
      const { io } = captureIo();
      const exitCode = await runCli(["run", "M001"], {
        io,
        servicesFactory: async () => recording.service,
      });
      expect(exitCode).toBe(kind === "completed" ? 0 : 1);
    }
  });

  it("handles underlying service errors cleanly with non-zero exit and no stack trace", async () => {
    const recording = recordingService({
      failure: new Error("store exploded"),
    });
    const { io, errors } = captureIo();

    const exitCode = await runCli(["run", "M001"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(1);
    const stderr = errors.join("\n");
    expect(stderr).toContain("error: store exploded");
    expect(stderr).not.toContain("    at ");
    expect(stderr).not.toContain("Error: ");
  });

  it("prints usage and exits with usage code for invalid arguments", async () => {
    const { io, errors } = captureIo();

    const unknownExit = await runCli(["frobnicate"], { io });
    expect(unknownExit).toBe(2);
    expect(errors.join("\n")).toContain("unknown command");

    const { io: io2, errors: errors2 } = captureIo();
    const missingTaskId = await runCli(["inspect"], { io: io2 });
    expect(missingTaskId).toBe(2);
    expect(errors2.join("\n")).toContain("requires a <task-id>");
  });

  it("prints help with zero exit", async () => {
    const { io, lines } = captureIo();
    const exitCode = await runCli(["--help"], { io });
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("agentic init");
  });

  it("handles unknown tasks for inspect cleanly with non-zero exit", async () => {
    const recording = recordingService({ inspection: null });
    const { io, errors } = captureIo();

    const exitCode = await runCli(["inspect", "M999"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('task "M999" was not found');
  });

  it("status and inspect render persisted data returned by the application service", async () => {
    const status: ProjectStatus = {
      project: createFixtureProject({ id: "proj-local" }),
      tasks: [
        {
          id: "M001",
          title: "Add a small utility function",
          status: "FAILED",
          updatedAt: "2026-01-01T00:00:00.000Z",
          attemptCount: 1,
          latestAttempt: {
            id: "att_M001_1",
            number: 1,
            status: "FAILED",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:05.000Z",
            failureMessage: "verification failed",
          },
        },
      ],
    };
    const recording = recordingService({ status });
    const { io, lines } = captureIo();

    const exitCode = await runCli(["status"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("proj-local");
    expect(output).toContain("[FAILED]");
    expect(output).toContain("verification failed");

    const inspection: TaskInspection = {
      task: createFixtureTask({ status: "FAILED" }),
      attempts: [
        {
          id: "att_M001_1",
          number: 1,
          status: "FAILED",
          agent: "fake-agent",
          model: null,
          baseRevision: "abc",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:05.000Z",
          failure: { kind: "verification_failed", message: "typecheck failed" },
          commit: null,
          integration: null,
        },
      ],
      events: [
        {
          sequence: 1,
          type: "task.transitioned",
          occurredAt: "2026-01-01T00:00:01.000Z",
          payload: { from: "READY", to: "IMPLEMENTING" },
        },
      ],
    };
    const inspectRecording = recordingService({ inspection });
    const inspectCapture = captureIo();

    const inspectExit = await runCli(["inspect", "M001"], {
      io: inspectCapture.io,
      servicesFactory: async () => inspectRecording.service,
    });

    expect(inspectExit).toBe(0);
    const inspectOutput = inspectCapture.lines.join("\n");
    expect(inspectOutput).toContain("[FAILED]");
    expect(inspectOutput).toContain("verification_failed");
    expect(inspectOutput).toContain("typecheck failed");
    expect(inspectOutput).toContain("task.transitioned");
  });

  it("delegates init exactly once and exits zero", async () => {
    const recording = recordingService({
      init: {
        projectId: "proj-local",
        projectRoot: "fixture",
        storePath: "fixture/state.db",
      },
    });
    const { io, lines } = captureIo();

    const exitCode = await runCli(["init"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(0);
    expect(recording.initCalls.count).toBe(1);
    expect(lines.join("\n")).toContain("fixture/state.db");
  });

  it("agents command delegates to the application service and renders the availability table", async () => {
    const recording = recordingService({
      agents: [
        { id: "opencode", available: true, version: "opencode 1.0.0", reason: null },
        { id: "codex", available: false, version: null, reason: "codex could not be started" },
      ],
    });
    const { io, lines } = captureIo();

    const exitCode = await runCli(["agents"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(0);
    expect(recording.listAgentsCalls.count).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("ID");
    expect(output).toContain("AVAILABLE");
    expect(output).toContain("opencode");
    expect(output).toContain("codex");
    expect(output).toContain("codex could not be started");
    const openCodeIndex = output.indexOf("opencode");
    const codexIndex = output.indexOf("codex");
    expect(openCodeIndex).toBeLessThan(codexIndex);
    expect(output).toContain("yes");
    expect(output).toContain("no");
  });

  it("agents command exits non-zero when discovery fails at the application layer", async () => {
    const recording = recordingService({
      failure: new Error("discovery exploded"),
    });
    const { io, errors } = captureIo();

    const exitCode = await runCli(["agents"], {
      io,
      servicesFactory: async () => recording.service,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("error: discovery exploded");
  });
});
