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

const STRESS_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-stress-agent.mjs", import.meta.url),
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

const TASK_IDS = [
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "S10",
] as const;

type TaskIdType = (typeof TASK_IDS)[number];

function buildTaskInput(taskId: TaskIdType): string {
  const lower = taskId.toLowerCase();
  const isSharedArea = taskId === "S9" || taskId === "S10";
  const allowedPaths = isSharedArea
    ? ["src/shared-area/**", "test/shared-area/**"]
    : [`src/${lower}/**`, `test/${lower}/**`];
  const resources =
    taskId === "S1" || taskId === "S2"
      ? ["resource-shared"]
      : isSharedArea
        ? []
        : [`resource-${lower}`];

  return JSON.stringify({
    id: taskId,
    title: `Stress task ${taskId}`,
    milestone: "parallel-stress",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective: `Create ${allowedPaths[0]} utility and its corresponding test.`,
    acceptance_criteria: [`${taskId} utility is implemented and verified.`],
    depends_on: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: allowedPaths, forbidden_paths: [] },
    resources,
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  });
}

type Span = { readonly taskId: string; readonly start: number; readonly end: number };

/** Wraps the production OpenCode adapter and records invocation spans. */
class RecordingStressAdapter implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "opencode" };
  readonly spans: Span[] = [];
  private readonly inner: AgentRuntime;

  constructor(runner: ProcessRunner) {
    this.inner = new OpenCodeAdapter(runner, {
      executable: process.execPath,
      launcherArgs: [STRESS_AGENT_SCRIPT],
    });
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    const start = Date.now();
    // The bounded overlap window makes concurrent admission observable even
    // for fast fixture agents.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await this.inner.invoke(invocation);
    const end = Date.now();
    this.spans.push({ taskId: invocation.contextPack.task.id, start, end });
    return result;
  }
}

describe("parallel stress and conflict invariants", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let tasksDir: string;
  let runner: ProcessRunner;
  let adapter: RecordingStressAdapter;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-parallel-stress-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    tasksDir = join(directory, "tasks");
    runner = createNodeProcessRunner();
    adapter = new RecordingStressAdapter(runner);
    await createFixtureRepository();
    for (const taskId of TASK_IDS) {
      writeFileSync(join(tasksDir, `task-${taskId}.json`), buildTaskInput(taskId), "utf8");
    }
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

  it("enforces capacity limits, resource locks, and path conflict invariants under parallel load", async () => {
    const io = captureIo();
    expect(await runCli(["init"], { io: io.io, servicesFactory: servicesFactory() })).toBe(0);
    for (const taskId of TASK_IDS) {
      const addIo = captureIo();
      const exit = await runCli(
        ["tasks", "add", join(tasksDir, `task-${taskId}.json`)],
        { io: addIo.io, servicesFactory: servicesFactory() },
      );
      expect(exit, `tasks add ${taskId} failed: ${addIo.errors.join("\n")}`).toBe(0);
    }

    const runIo = captureIo();
    const runExit = await runCli(["run", "--parallel", "4"], {
      io: runIo.io,
      servicesFactory: servicesFactory(),
    });
    expect(
      runExit,
      `run failed: lines=${JSON.stringify(runIo.lines)} errors=${JSON.stringify(runIo.errors)}`,
    ).toBe(0);

    // ---- Final persisted state is coherent -------------------------------
    store = await openRepositoryStore();
    for (const taskId of TASK_IDS) {
      expect((await store.getTask(taskId))?.status, `task ${taskId} status`).toBe("DONE");
    }
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);
    const queue = await store.listIntegrationQueueEntries();
    expect(queue).toHaveLength(10);
    expect(queue.every((entry) => entry.status === "COMPLETED")).toBe(true);

    // ---- Invariant proof: capacity, resource locks, and path conflicts ---
    const spans = adapter.spans;
    expect(spans).toHaveLength(10);

    const overlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

    // S1 and S2 share resource-shared; they must NOT overlap
    const shared = spans.filter((span) => span.taskId === "S1" || span.taskId === "S2");
    expect(shared).toHaveLength(2);
    expect(overlap(shared[0]!, shared[1]!)).toBe(false);

    // S9 and S10 both declare allowed_paths in src/shared-area/**; they must NOT overlap
    const sharedArea = spans.filter((span) => span.taskId === "S9" || span.taskId === "S10");
    expect(sharedArea).toHaveLength(2);
    expect(overlap(sharedArea[0]!, sharedArea[1]!)).toBe(false);

    // Concurrency limit: at any point in time, concurrent executions <= 4
    for (let i = 0; i < spans.length; i += 1) {
      let concurrent = 0;
      const at = spans[i]!.start + 1;
      for (const span of spans) {
        if (span.start <= at && at <= span.end) {
          concurrent += 1;
        }
      }
      expect(concurrent).toBeLessThanOrEqual(4);
    }

    // Verify that parallel execution actually ran concurrently (>= 2 concurrent tasks)
    let maxConcurrent = 0;
    for (let i = 0; i < spans.length; i += 1) {
      let concurrent = 0;
      const at = spans[i]!.start + 1;
      for (const span of spans) {
        if (span.start <= at && at <= span.end) {
          concurrent += 1;
        }
      }
      if (concurrent > maxConcurrent) {
        maxConcurrent = concurrent;
      }
    }
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);

    // ---- Separate worktrees and verification -----------------------------
    const worktreeEvents = await store.listEvents({ type: "worktree.created" });
    expect(worktreeEvents).toHaveLength(10);
    const worktreePaths = new Set(
      worktreeEvents.map((event) => (event.payload as { worktreePath: string }).worktreePath),
    );
    expect(worktreePaths.size).toBe(10);

    for (const taskId of TASK_IDS) {
      const verification = (await store.listEvents({ taskId, type: "verification.completed" }))
        .map((event) => event.payload as { status: string });
      expect(verification.length).toBeGreaterThanOrEqual(1);
      expect(
        verification.every((payload) => payload.status === "PASSED"),
        `task ${taskId} verification`,
      ).toBe(true);
    }

    // Integration queue entries were all completed
    expect(
      queue
        .map((entry) => ({ taskId: entry.taskId, status: entry.status }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    ).toEqual(
      [...TASK_IDS]
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({ taskId: id, status: "COMPLETED" })),
    );

    // Git history contains atomic commit for each task
    const logSubjects = (await git(["log", "--format=%s"])).split("\n");
    for (const taskId of TASK_IDS) {
      expect(
        logSubjects.some((subject) => subject.startsWith(`task ${taskId}: `)),
        `missing task ${taskId} commit`,
      ).toBe(true);
    }
    const logCount = (await git(["rev-list", "--count", "HEAD"])).trim();
    // 1 initial commit + 10 task commits = 11
    expect(logCount).toBe("11");

    await store.close();
    store = undefined;

    // ---- agentic status reports completion -------------------------------
    const statusIo = captureIo();
    expect(await runCli(["status"], { io: statusIo.io, servicesFactory: servicesFactory() })).toBe(0);
    const statusOutput = statusIo.lines.join("\n");
    expect(statusOutput).toContain("task totals: 10 DONE");
    expect(statusOutput).toContain("active tasks: (none)");
    expect(statusOutput).toContain("integration queue: 0 pending, 0 integrating, 10 completed, 0 failed");
  }, 120_000);
});
