import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const DAG_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-dag-agent.mjs", import.meta.url),
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

const TASK_INPUTS: Readonly<Record<"A" | "B" | "C", string>> = {
  A: JSON.stringify({
    id: "A",
    title: "Add the alpha title utility",
    milestone: "multi-task-dag",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective:
      "Create src/alpha/alpha.cjs exporting toUpperTitle with input validation, and test/alpha/alpha.test.cjs covering it.",
    acceptance_criteria: ["src/alpha/alpha.cjs exports toUpperTitle."],
    depends_on: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: ["src/alpha/**", "test/alpha/**"], forbidden_paths: [] },
    resources: ["resource-alpha"],
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  }),
  B: JSON.stringify({
    id: "B",
    title: "Add the beta slug utility",
    milestone: "multi-task-dag",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective:
      "Create src/beta/beta.cjs exporting toLowerSlug with input validation, and test/beta/beta.test.cjs covering it.",
    acceptance_criteria: ["src/beta/beta.cjs exports toLowerSlug."],
    depends_on: [],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: ["src/beta/**", "test/beta/**"], forbidden_paths: [] },
    resources: ["resource-beta"],
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  }),
  C: JSON.stringify({
    id: "C",
    title: "Add the gamma combined label utility",
    milestone: "multi-task-dag",
    status: "ready",
    priority: "P0",
    risk: "low",
    type: "implementation",
    objective:
      "Create src/gamma/gamma.cjs exporting combineLabel(value) that uses the alpha and beta utilities, and test/gamma/gamma.test.cjs covering it.",
    acceptance_criteria: [
      "src/gamma/gamma.cjs exports combineLabel(value).",
      "combineLabel uses both the alpha and the beta utility.",
    ],
    depends_on: ["A", "B"],
    provenance: { kind: "user_request", source: "manual" },
    scope: { allowed_paths: ["src/gamma/**", "test/gamma/**"], forbidden_paths: [] },
    resources: ["resource-gamma"],
    workflow: "simple",
    routing: { complexity: "small", capabilities: ["javascript"] },
    verification: { required: ["unit"] },
    limits: { max_attempts: 3, max_review_cycles: 2 },
    approval: { required: false },
  }),
};

const TASK_SCOPE_PREFIXES: Record<string, readonly string[]> = {
  A: ["src/alpha/", "test/alpha/"],
  B: ["src/beta/", "test/beta/"],
  C: ["src/gamma/", "test/gamma/"],
};

/** Wraps the production OpenCode adapter and records invocation spans. */
class RecordingDagAdapter implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "opencode" };
  readonly spans: { readonly taskId: string; readonly start: number; readonly end: number }[] = [];
  private readonly inner: AgentRuntime;

  constructor(runner: ProcessRunner) {
    this.inner = new OpenCodeAdapter(runner, {
      executable: process.execPath,
      launcherArgs: [DAG_AGENT_SCRIPT],
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

describe("M083a real multi-task CLI execution", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let tasksDir: string;
  let runner: ProcessRunner;
  let adapter: RecordingDagAdapter;
  let store: RunnerStore | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m083a-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    tasksDir = join(directory, "tasks");
    runner = createNodeProcessRunner();
    adapter = new RecordingDagAdapter(runner);
    await createFixtureRepository();
    writeFileSync(join(tasksDir, "task-A.json"), TASK_INPUTS.A, "utf8");
    writeFileSync(join(tasksDir, "task-B.json"), TASK_INPUTS.B, "utf8");
    writeFileSync(join(tasksDir, "task-C.json"), TASK_INPUTS.C, "utf8");
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

  it("executes the A/B/C DAG to DONE through the production agentic CLI path", async () => {
    const io = captureIo();
    expect(await runCli(["init"], { io: io.io, servicesFactory: servicesFactory() })).toBe(0);
    for (const taskId of ["A", "B", "C"]) {
      const addIo = captureIo();
      const exit = await runCli(
        ["tasks", "add", join(tasksDir, `task-${taskId}.json`)],
        { io: addIo.io, servicesFactory: servicesFactory() },
      );
      expect(exit, `tasks add ${taskId} failed: ${addIo.errors.join("\n")}`).toBe(0);
    }

    const runIo = captureIo();
    const runExit = await runCli(["run", "--parallel", "2"], {
      io: runIo.io,
      servicesFactory: servicesFactory(),
    });
    expect(
      runExit,
      `run failed: lines=${JSON.stringify(runIo.lines)} errors=${JSON.stringify(runIo.errors)}`,
    ).toBe(0);

    // ---- Final persisted state is coherent -------------------------------
    store = await openRepositoryStore();
    for (const taskId of ["A", "B", "C"]) {
      expect((await store.getTask(taskId))?.status, `task ${taskId}`).toBe("DONE");
    }
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);
    const queue = await store.listIntegrationQueueEntries();
    expect(
      queue
        .map((entry) => ({ taskId: entry.taskId, status: entry.status }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    ).toEqual([
      { taskId: "A", status: "COMPLETED" },
      { taskId: "B", status: "COMPLETED" },
      { taskId: "C", status: "COMPLETED" },
    ]);

    // ---- A and B were admitted concurrently ------------------------------
    const spans = [...adapter.spans];
    expect(spans.map((span) => span.taskId).sort()).toEqual(["A", "B", "C"]);
    const spanA = spans.find((span) => span.taskId === "A")!;
    const spanB = spans.find((span) => span.taskId === "B")!;
    const spanC = spans.find((span) => span.taskId === "C")!;
    expect(spanA.start < spanB.end && spanB.start < spanA.end).toBe(true);

    // ---- Separate worktrees were created per task ------------------------
    const attempts = {
      A: (await store.listAttempts({ taskId: "A" })).at(-1)!,
      B: (await store.listAttempts({ taskId: "B" })).at(-1)!,
      C: (await store.listAttempts({ taskId: "C" })).at(-1)!,
    };
    const worktreeEvents = await store.listEvents({ type: "worktree.created" });
    const worktreePaths = new Set(
      worktreeEvents.map((event) => (event.payload as { worktreePath: string }).worktreePath),
    );
    expect(worktreeEvents.length).toBe(3);
    expect(worktreePaths.size).toBe(3);

    // ---- C did not run before both dependencies reached DONE -------------
    expect(attempts.C.startedAt >= attempts.A.finishedAt!).toBe(true);
    expect(attempts.C.startedAt >= attempts.B.finishedAt!).toBe(true);
    expect(spanC.start).toBeGreaterThanOrEqual(Math.max(spanA.end, spanB.end) - 50);

    // ---- Verification really ran and passed ------------------------------
    for (const taskId of ["A", "B", "C"]) {
      const verification = (await store.listEvents({ taskId, type: "verification.completed" }))
        .map((event) => event.payload as { status: string });
      expect(verification.length).toBeGreaterThanOrEqual(1);
      expect(verification.every((payload) => payload.status === "PASSED"), `task ${taskId}`)
        .toBe(true);
    }
    const integrationVerification = await store.listEvents({
      type: "integration.verification.completed",
    });
    expect(integrationVerification.map((event) => event.taskId).sort()).toEqual(["A", "B", "C"]);

    // ---- Task scope remained isolated ------------------------------------
    const implementationEvents = await store.listEvents({ type: "implementation.completed" });
    for (const event of implementationEvents) {
      const payload = event.payload as { attemptId: string; changedPaths: readonly string[] };
      const taskId = payload.attemptId.split("_")[1] ?? "";
      const allowed: readonly string[] = TASK_SCOPE_PREFIXES[taskId] ?? [];
      expect(allowed.length, `unknown task scope for attempt ${payload.attemptId}`).toBeGreaterThan(0);
      for (const changedPath of payload.changedPaths) {
        expect(
          allowed.some((prefix) => changedPath.startsWith(prefix)),
          `task ${taskId} changed out-of-scope path ${changedPath}`,
        ).toBe(true);
      }
    }

    // ---- Integration was serialized in queue order -----------------------
    const ordered = [...queue].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!.claimedAt! >= ordered[i - 1]!.finishedAt!).toBe(true);
    }

    // ---- Final Git history contains the atomic task commits --------------
    const logSubjects = (await git(["log", "--format=%s"])).split("\n");
    for (const taskId of ["A", "B", "C"]) {
      expect(
        logSubjects.some((subject) => subject.startsWith(`task ${taskId}: `)),
        `missing task ${taskId} commit`,
      ).toBe(true);
    }
    const logCount = (await git(["rev-list", "--count", "HEAD"])).trim();
    expect(logCount).toBe("4");
    expect(readFileSync(join(repositoryPath, "src/gamma/gamma.cjs"), "utf8")).toContain(
      "module.exports = { combineLabel };",
    );
    await store.close();
    store = undefined;

    // ---- agentic status reports completion -------------------------------
    const statusIo = captureIo();
    expect(await runCli(["status"], { io: statusIo.io, servicesFactory: servicesFactory() })).toBe(0);
    const statusOutput = statusIo.lines.join("\n");
    expect(statusOutput).toContain("task totals: 3 DONE");
    expect(statusOutput).toContain("active tasks: (none)");
    expect(statusOutput).toContain("integration queue: 0 pending, 0 integrating, 3 completed, 0 failed");
    expect(statusOutput).toContain("parallel capacity: 1 configured, 0 active, 1 available");
    expect(statusOutput.match(/\[DONE\]/g)).toHaveLength(3);

    // ---- agentic inspect explains each task's history --------------------
    for (const taskId of ["A", "B", "C"]) {
      const inspectIo = captureIo();
      const inspectExit = await runCli(["inspect", taskId], {
        io: inspectIo.io,
        servicesFactory: servicesFactory(),
      });
      expect(inspectExit, `inspect ${taskId} failed`).toBe(0);
      const output = inspectIo.lines.join("\n");
      expect(output).toContain(`task: ${taskId}`);
      expect(output).toContain("status: DONE");
      expect(output).toContain(`#1 att_${taskId}_1 [SUCCEEDED]`);
      expect(output).toContain(`commit:`);
      expect(output).toContain(`integration: fast-forward at`);
      expect(output).toContain("VERIFY [SUCCEEDED]");
      expect(output).toContain("INTEGRATE [SUCCEEDED]");
      expect(output).toContain("integration queue:");
      expect(output).toContain("[COMPLETED]");
    }
  }, 120_000);
});
