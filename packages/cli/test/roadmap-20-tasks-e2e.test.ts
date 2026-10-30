import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const ROADMAP_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-roadmap-agent.mjs", import.meta.url),
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

const LAYERS: readonly (readonly string[])[] = [
  ["T01", "T02", "T03", "T04", "T05", "T06"],
  ["T07", "T08", "T09", "T10", "T11", "T12"],
  ["T13", "T14", "T15", "T16", "T17"],
  ["T18", "T19", "T20"],
];

const DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  T07: ["T01", "T02"],
  T08: ["T03"],
  T09: ["T04", "T05"],
  T10: ["T06"],
  T11: ["T02", "T06"],
  T12: ["T01", "T05"],
  T13: ["T07", "T08"],
  T14: ["T09", "T10"],
  T15: ["T11"],
  T16: ["T12"],
  T17: ["T07", "T11"],
  T18: ["T13", "T14"],
  T19: ["T15", "T16"],
  T20: ["T17"],
};

const SHARED_RESOURCES = ["resource-roadmap-shared"] as const;
const SHARED_TASK_IDS: ReadonlySet<string> = new Set(["T01", "T02", "T07", "T11"]);

/** Bounded evidence dump: failure messages are truncated at this many chars. */
const MESSAGE_LIMIT = 400;

type TaskDefinition = {
  readonly id: string;
  readonly title: string;
  readonly milestone: string;
  readonly status: string;
  readonly priority: string;
  readonly risk: string;
  readonly type: string;
  readonly objective: string;
  readonly acceptance_criteria: readonly string[];
  readonly depends_on: readonly string[];
  readonly provenance: { readonly kind: string; readonly source: string };
  readonly scope: {
    readonly allowed_paths: readonly string[];
    readonly forbidden_paths: readonly string[];
  };
  readonly resources: readonly string[];
  readonly workflow: string;
  readonly routing: {
    readonly complexity: string;
    readonly capabilities: readonly string[];
  };
  readonly verification: { readonly required: readonly string[] };
  readonly limits: { readonly max_attempts: number; readonly max_review_cycles: number };
  readonly approval: { readonly required: boolean };
};

function buildTasks(): readonly TaskDefinition[] {
  const allIds = LAYERS.flat();
  return allIds.map((taskId) => {
    const lower = taskId.toLowerCase();
    const resources = SHARED_TASK_IDS.has(taskId)
      ? [...SHARED_RESOURCES]
      : [`resource-${lower}`];
    return {
      id: taskId,
      title: `Roadmap task ${taskId}`,
      milestone: "roadmap-v01",
      status: "ready",
      priority: "P0",
      risk: "low",
      type: "implementation",
      objective: `Create src/${lower}/${lower}.cjs utility and its corresponding test.`,
      acceptance_criteria: [`${taskId} utility is implemented and verified.`],
      depends_on: DEPENDENCIES[taskId] ?? [],
      provenance: { kind: "user_request", source: "manual" },
      scope: {
        allowed_paths: [`src/${lower}/**`, `test/${lower}/**`],
        forbidden_paths: [],
      },
      resources,
      workflow: "simple",
      routing: { complexity: "small", capabilities: ["javascript"] },
      verification: { required: ["unit"] },
      limits: { max_attempts: 3, max_review_cycles: 2 },
      approval: { required: false },
    };
  });
}

const TASKS = buildTasks();

type Span = { readonly taskId: string; readonly start: number; readonly end: number };

/** Wraps the production OpenCode adapter and records invocation spans. */
class RecordingRoadmapAdapter implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "opencode" };
  readonly spans: Span[] = [];
  private readonly inner: AgentRuntime;

  constructor(runner: ProcessRunner) {
    this.inner = new OpenCodeAdapter(runner, {
      executable: process.execPath,
      launcherArgs: [ROADMAP_AGENT_SCRIPT],
    });
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    const start = Date.now();
    const result = await this.inner.invoke(invocation);
    const end = Date.now();
    this.spans.push({ taskId: invocation.contextPack.task.id, start, end });
    return result;
  }
}

describe("20-task roadmap e2e execution (release criterion 1)", () => {
  let directory: string;
  let repositoryPath: string;
  let stateDir: string;
  let tasksDir: string;
  let runner: ProcessRunner;
  let adapter: RecordingRoadmapAdapter;
  let store: RunnerStore | undefined;
  let activeTest: Promise<void> | undefined;
  let setup: Promise<void> | undefined;

  async function setupFixture(): Promise<void> {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-roadmap-20-"));
    repositoryPath = join(directory, "fixture repo");
    stateDir = join(directory, "runner state");
    tasksDir = join(directory, "tasks");
    runner = createNodeProcessRunner();
    adapter = new RecordingRoadmapAdapter(runner);
    await createFixtureRepository();
    for (const task of TASKS) {
      writeFileSync(join(tasksDir, `task-${task.id}.json`), JSON.stringify(task), "utf8");
    }
  }

  beforeEach(() => {
    setup = setupFixture();
    return setup;
  });

  afterEach(async () => {
    await Promise.allSettled([setup, activeTest]);
    activeTest = undefined;
    setup = undefined;
    await store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 300_000);

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

  /**
   * Compact structured dump of the durable retained evidence for one task
   * that did not reach DONE, fetched from the store before cleanup. Only
   * status/failure/timing fields are kept: raw agent output (attempt logs,
   * stage stdout/stderr, plans, context payloads) is excluded and messages
   * are truncated so the dump stays small. JSON.stringify serializes
   * deterministically for stderr across Linux/macOS/Windows.
   */
  async function formatTaskFailureEvidence(store: RunnerStore, taskId: string): Promise<string> {
    const [record, attempts, claims, queueEntries, events] = await Promise.all([
      store.getTask(taskId),
      store.listAttempts({ taskId }),
      store.listExecutionClaims({ taskId }),
      store.listIntegrationQueueEntries({ taskId }),
      store.listEvents({ taskId }),
    ]);
    const stageRunsByAttempt = await Promise.all(
      attempts.map(async (attempt) => ({
        attemptId: attempt.id,
        stages: await store.listStageRuns(attempt.id),
      })),
    );
    return JSON.stringify(
      {
        taskId,
        recordStatus: record?.status ?? null,
        recordUpdatedAt: record?.updatedAt ?? null,
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          number: attempt.number,
          status: attempt.status,
          agent: attempt.agent,
          model: attempt.model ?? null,
          baseRevision: attempt.baseRevision,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt ?? null,
          failure: compactFailure(attempt.failure),
          logsLocation: attempt.logs?.location ?? null,
        })),
        stageRuns: stageRunsByAttempt.map(({ attemptId, stages }) => ({
          attemptId,
          stages: stages.map((stage) => ({
            attemptId: stage.attemptId,
            stage: stage.stage,
            status: stage.status,
            startedAt: stage.startedAt ?? null,
            finishedAt: stage.finishedAt ?? null,
            failure: compactFailure(stage.failure),
            output: stage.output
              ? {
                  ...stage.output,
                  plan: undefined,
                  stdout: undefined,
                  stderr: undefined,
                }
              : undefined,
          })),
        })),
        executionClaims: claims.map((claim) => ({
          id: claim.id,
          status: claim.status,
          claimedAt: claim.claimedAt,
          renewedAt: claim.renewedAt,
          leaseExpiresAt: claim.leaseExpiresAt,
          finishedAt: claim.finishedAt ?? null,
          failure: compactFailure(claim.failure),
        })),
        integrationQueueEntries: queueEntries.map((entry) => ({
          id: entry.id,
          sequence: entry.sequence,
          attemptId: entry.attemptId,
          status: entry.status,
          taskRevision: entry.taskRevision,
          branch: entry.branch,
          baseRevision: entry.baseRevision,
          enqueuedAt: entry.enqueuedAt,
          claimedAt: entry.claimedAt ?? null,
          finishedAt: entry.finishedAt ?? null,
          failure: compactFailure(entry.failure),
        })),
        events: events.map((event) => ({
          sequence: event.sequence,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: /fail|error|timeout|cancel/i.test(event.type)
            ? truncationSafe(event.payload)
            : undefined,
        })),
      },
      null,
      2,
    );
  }

  function compactFailure(
    failure: { readonly kind?: string | undefined; readonly message?: string | undefined } | null | undefined,
  ): { kind?: string | undefined; message?: string | undefined } | null {
    if (failure === null || failure === undefined) {
      return null;
    }
    const compact: { kind?: string | undefined; message?: string | undefined } = {};
    if (failure.kind !== undefined) {
      compact.kind = failure.kind;
    }
    if (failure.message !== undefined) {
      compact.message = truncateMessage(failure.message);
    }
    return compact;
  }

  function truncateMessage(message: string): string {
    return message.length <= MESSAGE_LIMIT ? message : `${message.slice(0, MESSAGE_LIMIT)}…(truncated ${message.length - MESSAGE_LIMIT} chars)`;
  }

  function truncationSafe(payload: unknown): unknown {
    return truncateMessage(JSON.stringify(payload) ?? "null");
  }

  async function executeRoadmapTest(): Promise<void> {
    const io = captureIo();
    expect(await runCli(["init"], { io: io.io, servicesFactory: servicesFactory() })).toBe(0);
    for (const task of TASKS) {
      const addIo = captureIo();
      const exit = await runCli(
        ["tasks", "add", join(tasksDir, `task-${task.id}.json`)],
        { io: addIo.io, servicesFactory: servicesFactory() },
      );
      expect(exit, `tasks add ${task.id} failed: ${addIo.errors.join("\n")}`).toBe(0);
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

    // 1. All 20 tasks DONE. Before asserting, fetch durable retained evidence
    // for any task that did not reach DONE (while the store is still open,
    // before afterEach cleanup) and emit it so the failure is diagnosable.
    const evidenceStore = await openRepositoryStore();
    store = evidenceStore;
    const notDone: string[] = [];
    for (const task of TASKS) {
      const record = await evidenceStore.getTask(task.id);
      if (record?.status !== "DONE") {
        notDone.push(task.id);
      }
    }
    if (notDone.length > 0) {
      const evidence = await Promise.all(
        notDone.map((taskId) => formatTaskFailureEvidence(evidenceStore, taskId)),
      );
      process.stderr.write(
        `TASK-FAILURE-EVIDENCE (durable store state for ${notDone.length} task(s) not DONE; raw agent logs excluded)\n${evidence.join("\n")}\n`,
      );
    }
    for (const task of TASKS) {
      const record = await store.getTask(task.id);
      expect(record?.status, `task ${task.id} status`).toBe("DONE");
    }
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);

    // 2. Every attempt's startedAt >= each dependency's finishedAt
    for (const [taskId, deps] of Object.entries(DEPENDENCIES)) {
      const attempts = await store.listAttempts({ taskId });
      const attempt = attempts.at(-1);
      expect(attempt, `task ${taskId} has attempt`).toBeDefined();
      const startedAt = new Date(attempt!.startedAt).getTime();

      for (const depId of deps) {
        const depAttempts = await store.listAttempts({ taskId: depId });
        const depAttempt = depAttempts.at(-1);
        expect(depAttempt, `dependency ${depId} has attempt`).toBeDefined();
        expect(depAttempt!.finishedAt, `dependency ${depId} has finishedAt`).toBeDefined();
        const depFinishedAt = new Date(depAttempt!.finishedAt!).getTime();
        expect(
          startedAt >= depFinishedAt,
          `task ${taskId} startedAt (${attempt!.startedAt}) must be >= dependency ${depId} finishedAt (${depAttempt!.finishedAt})`,
        ).toBe(true);
      }
    }

    // 3. Shared-resource tasks' spans (T01, T02, T07, T11) are pairwise disjoint
    const overlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;
    const sharedSpans = adapter.spans.filter((span) =>
      SHARED_TASK_IDS.has(span.taskId),
    );
    expect(sharedSpans).toHaveLength(4);
    for (let i = 0; i < sharedSpans.length; i += 1) {
      for (let j = i + 1; j < sharedSpans.length; j += 1) {
        expect(
          overlap(sharedSpans[i]!, sharedSpans[j]!),
          `spans for ${sharedSpans[i]!.taskId} and ${sharedSpans[j]!.taskId} must not overlap`,
        ).toBe(false);
      }
    }

    // 4. listIntegrationQueueEntries() has 20 COMPLETED and 0 PENDING/INTEGRATING
    const queue = await store.listIntegrationQueueEntries();
    expect(queue).toHaveLength(20);
    expect(queue.filter((entry) => entry.status === "COMPLETED")).toHaveLength(20);
    expect(queue.filter((entry) => entry.status === "PENDING" || entry.status === "INTEGRATING")).toHaveLength(0);

    // 5. integration.verification.completed events == 20
    const integrationVerificationEvents = await store.listEvents({
      type: "integration.verification.completed",
    });
    expect(integrationVerificationEvents).toHaveLength(20);

    // 6. worktree.created events == 20 with 20 distinct paths
    const worktreeEvents = await store.listEvents({ type: "worktree.created" });
    expect(worktreeEvents).toHaveLength(20);
    const worktreePaths = new Set(
      worktreeEvents.map((event) => (event.payload as { worktreePath: string }).worktreePath),
    );
    expect(worktreePaths.size).toBe(20);

    // 7. git rev-list --count HEAD == 21 and each task <id>: subject exists
    const logCount = (await git(["rev-list", "--count", "HEAD"])).trim();
    expect(logCount).toBe("21");

    const logSubjects = (await git(["log", "--format=%s"])).split("\n");
    for (const task of TASKS) {
      expect(
        logSubjects.some((subject) => subject.startsWith(`task ${task.id}: `)),
        `missing task ${task.id} commit`,
      ).toBe(true);
    }

    // 8. Sampled final source file exists for T20
    expect(existsSync(join(repositoryPath, "src/t20/t20.cjs"))).toBe(true);
    expect(readFileSync(join(repositoryPath, "src/t20/t20.cjs"), "utf8")).toContain('return "T20";');

    await store.close();
    store = undefined;

    // CLI status reports completion
    const statusIo = captureIo();
    expect(await runCli(["status"], { io: statusIo.io, servicesFactory: servicesFactory() })).toBe(0);
    const statusOutput = statusIo.lines.join("\n");
    expect(statusOutput).toContain("task totals: 20 DONE");
    expect(statusOutput).toContain("active tasks: (none)");
    expect(statusOutput).toContain("integration queue: 0 pending, 0 integrating, 20 completed, 0 failed");
  }

  it("executes a 20-task DAG to DONE with correct ordering, disjoint shared-resource spans, isolated worktrees, and serialized integration", () => {
    activeTest = executeRoadmapTest();
    return activeTest;
  }, process.platform === "win32" ? 300_000 : 120_000);
});
