import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "@agentic-dev-runner/core";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createVerificationEngine } from "@agentic-dev-runner/verification";
import type { VerificationCheckSpec } from "@agentic-dev-runner/verification";
import { OpenCodeAdapter } from "@agentic-dev-runner/agents";
import {
  createCrashRecovery,
  createSingleTaskOrchestrator,
  ORCHESTRATION_EVENTS,
} from "../../src/index.js";
import type {
  CompletedTaskRun,
  CrashRecovery,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
} from "../../src/index.js";
import { runFixtureGit } from "../fixtures.js";

const FAKE_AGENT_SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-opencode-coding-agent.mjs", import.meta.url),
);

const LIVE_ENABLED = process.env.AGENTIC_OPENCODE_LIVE_E2E === "1";
const LIVE_MODEL = process.env.AGENTIC_OPENCODE_MODEL;

const TASK_ID = "T001";
const ATTEMPT_ID = `att_${TASK_ID}_1`;
const BRANCH = `task/${TASK_ID}/attempt-1`;
const CLAMP_SOURCE = "src/math/clamp.cjs";
const CLAMP_TEST = "test/math/clamp.test.cjs";
const COMMIT_MESSAGE = `task ${TASK_ID}: Add a small validated utility function with tests.`;

const JOURNAL_TIMEOUT_MS = 15_000;
const JOURNAL_POLL_MS = 10;
const E2E_TIMEOUT_MS = 60_000;
const LIVE_E2E_TIMEOUT_MS = 20 * 60 * 1000;
const RELEASE_TIMEOUT_MS = 30_000;

const AGENTS_MARKDOWN = [
  "# Fixture rules",
  "",
  "- Implement exactly one utility function per task.",
  "- Always add tests for new functions.",
  "- Never touch files outside the allowed paths.",
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

const VERIFICATION_CHECKS: readonly VerificationCheckSpec[] = [
  { name: "typecheck", executable: "node", args: ["--check", CLAMP_SOURCE] },
  { name: "unit", executable: "node", args: ["--test", "test/**/*.test.cjs"] },
];

let directory: string;
let repoPath: string;
let worktreesDir: string;
let worktreePath: string;
let dbPath: string;
let journalPath: string;
let releasePath: string;
let baseRevision: string;
let runner: ProcessRunner;
let store: RunnerStore;
let git: ReturnType<typeof createGitManager>;
let orchestrator: SingleTaskOrchestrator;
let recovery: CrashRecovery;

type JournalEntry = {
  phase?: string | undefined;
  argv?: string[] | undefined;
  cwd?: string | undefined;
  insideWorktree?: boolean | undefined;
  taskId?: string | null | undefined;
  changed?: string[] | undefined;
};

type AgentReport = {
  argv: string[];
  cwd: string;
  insideWorktree: boolean;
  taskId: string | null;
  objective: string | null;
  agentsMarkdownPath: string | null;
  changed: string[];
};

function manualVerticalSliceTask(): Task {
  return {
    id: TASK_ID,
    projectId: "proj-vs014",
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
      scope: {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: ["docs/**"],
      },
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

async function createVerticalSliceFixtureRepository(
  runner: ProcessRunner,
  repositoryPath: string,
): Promise<string> {
  mkdirSync(repositoryPath, { recursive: true });
  writeFileSync(join(repositoryPath, "AGENTS.md"), AGENTS_MARKDOWN);
  writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
  mkdirSync(join(repositoryPath, "src", "math"), { recursive: true });
  writeFileSync(join(repositoryPath, "src", "math", "validate.cjs"), VALIDATE_SOURCE);
  mkdirSync(join(repositoryPath, "test", "math"), { recursive: true });
  writeFileSync(join(repositoryPath, "test", "math", "validate.test.cjs"), VALIDATE_TEST);
  await runFixtureGit(runner, repositoryPath, ["init"]);
  await runFixtureGit(runner, repositoryPath, [
    "config",
    "user.email",
    "runner@example.com",
  ]);
  await runFixtureGit(runner, repositoryPath, [
    "config",
    "user.name",
    "Agentic Runner Fixture",
  ]);
  await runFixtureGit(runner, repositoryPath, ["config", "core.autocrlf", "false"]);
  await runFixtureGit(runner, repositoryPath, ["add", "."]);
  await runFixtureGit(runner, repositoryPath, ["commit", "-m", "initial commit"]);
  return (await runFixtureGit(runner, repositoryPath, ["rev-parse", "HEAD"])).trim();
}

function readJournalEntries(): JournalEntry[] {
  if (!existsSync(journalPath)) {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // partial append; retried on the next poll
    }
  }
  return entries;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForJournalPhase(
  phase: string,
  pending: Promise<SingleTaskRunOutcome>,
): Promise<JournalEntry[]> {
  const deadline = Date.now() + JOURNAL_TIMEOUT_MS;
  for (;;) {
    const entries = readJournalEntries();
    if (entries.some((entry) => entry.phase === phase)) {
      return entries;
    }
    if (Date.now() > deadline) {
      const outcome = await pending;
      throw new Error(
        `agent journal never reached phase "${phase}"; orchestrator outcome: ${JSON.stringify(outcome)}; journal: ${JSON.stringify(entries)}`,
      );
    }
    await delay(JOURNAL_POLL_MS);
  }
}

function expectCompleted(
  outcome: SingleTaskRunOutcome,
): asserts outcome is CompletedTaskRun {
  if (outcome.kind !== "completed") {
    throw new Error(
      `expected a completed outcome but received "${outcome.kind}": ${JSON.stringify(outcome, null, 2)}`,
    );
  }
}

describe("VS014 real vertical slice end-to-end", () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-vs014-"));
    repoPath = join(directory, "fixture repo");
    worktreesDir = join(directory, "task worktrees");
    worktreePath = join(worktreesDir, TASK_ID, "attempt-1");
    dbPath = join(directory, "state.db");
    journalPath = join(directory, "agent-journal.jsonl");
    releasePath = join(directory, "agent-release.marker");
    runner = createNodeProcessRunner();
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    baseRevision = await createVerticalSliceFixtureRepository(runner, repoPath);
    await store.putProject({
      id: "proj-vs014",
      name: "vs014-fixture",
      rootPath: repoPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.putTask(manualVerticalSliceTask());
    git = createGitManager({ runner });
    const agent = new OpenCodeAdapter(runner, {
      executable: process.execPath,
      launcherArgs: [FAKE_AGENT_SCRIPT],
    });
    const verification = createVerificationEngine({ runner });
    orchestrator = createSingleTaskOrchestrator({
      store,
      git,
      agent,
      verification,
      verificationChecks: VERIFICATION_CHECKS,
      projectRoot: repoPath,
      worktreesDir,
      agentTimeoutMs: 60_000,
    });
    recovery = createCrashRecovery({
      store,
      git,
      verification,
      verificationChecks: VERIFICATION_CHECKS,
      projectRoot: repoPath,
      worktreesDir,
    });
    process.env.AGENTIC_FAKE_AGENT_JOURNAL = journalPath;
    process.env.AGENTIC_FAKE_AGENT_RELEASE_FILE = releasePath;
    process.env.AGENTIC_FAKE_AGENT_RELEASE_TIMEOUT_MS = String(RELEASE_TIMEOUT_MS);
  });

  afterEach(async () => {
    await store.close();
    delete process.env.AGENTIC_FAKE_AGENT_JOURNAL;
    delete process.env.AGENTIC_FAKE_AGENT_RELEASE_FILE;
    delete process.env.AGENTIC_FAKE_AGENT_RELEASE_TIMEOUT_MS;
    rmSync(directory, { recursive: true, force: true });
  });

  it("executes the whole vertical slice against a real fixture repository", async () => {
    const seededTask = await store.getTask(TASK_ID);
    expect(seededTask?.status).toBe("READY");

    const pending = orchestrator.run(TASK_ID);
    try {
      await waitForJournalPhase("started", pending);

      expect(await store.getTaskStatus(TASK_ID)).toBe("IMPLEMENTING");
      expect(await git.branchExists(repoPath, BRANCH)).toBe(true);
      expect(await git.worktreeExists(repoPath, worktreePath)).toBe(true);
      expect((await git.status(worktreePath)).clean).toBe(true);
      expect(await git.resolveHeadRevision(worktreePath)).toBe(baseRevision);
      expect(await git.resolveHeadRevision(repoPath)).toBe(baseRevision);
      expect((await git.status(repoPath)).clean).toBe(true);
    } finally {
      writeFileSync(releasePath, "release\n");
    }

    await waitForJournalPhase("changed", pending);
    const outcome = await pending;
    expectCompleted(outcome);

    expect(outcome.taskId).toBe(TASK_ID);
    expect(outcome.attemptId).toBe(ATTEMPT_ID);
    expect(outcome.branch).toBe(BRANCH);
    expect(outcome.worktreePath).toBe(worktreePath);

    const startedEntry = readJournalEntries().find(
      (entry) => entry.phase === "started",
    );
    expect(startedEntry?.cwd).toBe(worktreePath);
    expect(startedEntry?.insideWorktree).toBe(true);
    expect(startedEntry?.taskId).toBe(TASK_ID);

    const attempt = outcome.attempt;
    expect(attempt.id).toBe(ATTEMPT_ID);
    expect(attempt.taskId).toBe(TASK_ID);
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.agent).toBe("opencode");
    expect(attempt.baseRevision).toBe(baseRevision);
    expect(attempt.logs?.stderr).toBe("");
    const report = JSON.parse(attempt.logs?.stdout ?? "null") as
      | AgentReport
      | null;
    expect(report?.cwd).toBe(worktreePath);
    expect(report?.insideWorktree).toBe(true);
    expect(report?.taskId).toBe(TASK_ID);
    expect(report?.objective).toBe(
      "Create src/math/clamp.cjs exporting clamp(value, min, max) with input validation, and test/math/clamp.test.cjs covering it.",
    );
    expect(report?.agentsMarkdownPath).toBe("AGENTS.md");
    expect(report?.argv[0]).toBe("run");
    expect(report?.argv).not.toContain("--model");
    expect(report?.changed).toEqual([CLAMP_SOURCE, CLAMP_TEST]);
    expect(attempt.contextManifest?.createdAt).toBeDefined();
    expect(
      attempt.contextManifest?.entries.map((entry) => entry.kind),
    ).toEqual([
      "task",
      "agents_md",
      "allowed_paths",
      "forbidden_paths",
      "base_revision",
    ]);
    expect(
      attempt.contextManifest?.entries.find((entry) => entry.kind === "task")
        ?.source,
    ).toBe(TASK_ID);

    const events = await store.listEvents({ taskId: TASK_ID });
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      ORCHESTRATION_EVENTS.attemptStarted,
      ORCHESTRATION_EVENTS.taskTransitioned,
      ORCHESTRATION_EVENTS.worktreeCreated,
      ORCHESTRATION_EVENTS.implementationCompleted,
      ORCHESTRATION_EVENTS.taskTransitioned,
      ORCHESTRATION_EVENTS.verificationCompleted,
      ORCHESTRATION_EVENTS.commitCreated,
      ORCHESTRATION_EVENTS.taskTransitioned,
      ORCHESTRATION_EVENTS.integrationCompleted,
      ORCHESTRATION_EVENTS.taskTransitioned,
    ]);

    const commitEvent = events.find(
      (event) => event.type === ORCHESTRATION_EVENTS.commitCreated,
    );
    const commitPayload = commitEvent?.payload as
      | { revision?: string; message?: string }
      | undefined;
    expect(commitPayload?.message).toBe(COMMIT_MESSAGE);
    const commitRevision = commitPayload?.revision;
    expect(typeof commitRevision).toBe("string");
    expect(outcome.integration.kind).toBe("fast-forward");
    expect(outcome.integration.revision).toBe(commitRevision);

    const integrationEvents = events.filter(
      (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
    );
    expect(integrationEvents).toHaveLength(1);
    const integrationPayload = integrationEvents[0]?.payload as {
      revision?: string;
      kind?: string;
    };
    expect(integrationPayload.revision).toBe(commitRevision);
    expect(integrationPayload.kind).toBe("fast-forward");

    const verificationEvent = events.find(
      (event) => event.type === ORCHESTRATION_EVENTS.verificationCompleted,
    );
    const verificationPayload = verificationEvent?.payload as
      | { status?: string; checks?: { kind: string; outcome: string; command?: string[] }[] }
      | undefined;
    const verificationChecks = verificationPayload?.checks;
    if (verificationChecks === undefined) {
      throw new Error(
        `verification.completed event payload has no checks: ${JSON.stringify(verificationEvent)}`,
      );
    }
    expect(verificationPayload?.status).toBe("PASSED");
    expect(verificationChecks.map((check) => check.kind)).toEqual([
      "typecheck",
      "unit",
    ]);
    expect(verificationChecks.map((check) => check.outcome)).toEqual([
      "PASSED",
      "PASSED",
    ]);
    expect(verificationChecks.map((check) => check.command)).toEqual([
      ["node", "--check", CLAMP_SOURCE],
      ["node", "--test", "test/**/*.test.cjs"],
    ]);

    const transitions = events
      .filter((event) => event.type === ORCHESTRATION_EVENTS.taskTransitioned)
      .map((event) => event.payload as { from: string; to: string; attemptId?: string });
    expect(transitions).toEqual([
      { from: "READY", to: "IMPLEMENTING", attemptId: ATTEMPT_ID },
      { from: "IMPLEMENTING", to: "VERIFYING", attemptId: ATTEMPT_ID },
      { from: "VERIFYING", to: "INTEGRATING", attemptId: ATTEMPT_ID },
      { from: "INTEGRATING", to: "DONE", attemptId: ATTEMPT_ID },
    ]);
    const integrationEventIndex = events.findIndex(
      (event) => event.type === ORCHESTRATION_EVENTS.integrationCompleted,
    );
    const doneTransitionIndex = events.findIndex(
      (event) =>
        event.type === ORCHESTRATION_EVENTS.taskTransitioned &&
        (event.payload as { to?: string }).to === "DONE",
    );
    expect(doneTransitionIndex).toBeGreaterThan(integrationEventIndex);

    expect(await store.getTaskStatus(TASK_ID)).toBe("DONE");
    const finishedTask = await store.getTask(TASK_ID);
    expect(finishedTask?.status).toBe("DONE");
    expect(finishedTask?.updatedAt).toBeTypeOf("string");

    expect(await git.resolveHeadRevision(repoPath)).toBe(commitRevision);
    expect(await git.resolveBranchRevision(repoPath, BRANCH)).toBe(
      commitRevision,
    );
    const commitCount = await runFixtureGit(runner, repoPath, [
      "rev-list",
      "--count",
      `${baseRevision}..${BRANCH}`,
    ]);
    expect(commitCount.trim()).toBe("1");
    expect(outcome.cleanup?.kind).toBe("removed");
    expect(existsSync(worktreePath)).toBe(false);
    expect(await git.worktreeExists(repoPath, worktreePath)).toBe(false);
    expect(await git.branchExists(repoPath, BRANCH)).toBe(true);
    expect((await git.status(repoPath)).clean).toBe(true);

    expect(readFileSync(join(repoPath, CLAMP_SOURCE), "utf8")).toContain(
      "module.exports = { clamp };",
    );
    expect(readFileSync(join(repoPath, CLAMP_TEST), "utf8")).toContain(
      'require("../../src/math/clamp.cjs")',
    );

    const recoveryOutcome = await recovery.reconcileTask(TASK_ID);
    if (recoveryOutcome.kind !== "no-op") {
      throw new Error(
        `expected reconciliation of the completed task to be a no-op but received "${recoveryOutcome.kind}": ${JSON.stringify(recoveryOutcome, null, 2)}`,
      );
    }
    expect(recoveryOutcome.detail).toContain('"DONE"');

    const persistedEvents = JSON.stringify(
      await store.listEvents({ taskId: TASK_ID }),
    );
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    await reopened.initialize();
    const reopenedTask = await reopened.getTask(TASK_ID);
    expect(reopenedTask?.status).toBe("DONE");
    const reopenedAttempt = await reopened.getAttempt(ATTEMPT_ID);
    expect(reopenedAttempt?.status).toBe("SUCCEEDED");
    expect(reopenedAttempt?.agent).toBe("opencode");
    expect(reopenedAttempt?.contextManifest).toEqual(attempt.contextManifest);
    expect(JSON.stringify(await reopened.listEvents({ taskId: TASK_ID }))).toBe(
      persistedEvents,
    );
    const reopenedVerification = await reopened.listEvents({
      taskId: TASK_ID,
      type: ORCHESTRATION_EVENTS.verificationCompleted,
    });
    expect(reopenedVerification).toHaveLength(1);
    await reopened.close();
  }, E2E_TIMEOUT_MS);

  describe.skipIf(!LIVE_ENABLED)(
    "live OpenCode vertical slice (AGENTIC_OPENCODE_LIVE_E2E)",
    () => {
      it("executes the vertical slice with the real opencode CLI and model access", async () => {
        const version = await runner.run({
          executable: "opencode",
          args: ["--version"],
        });
        if (
          version.outcome.kind === "spawn-error" &&
          version.outcome.code === "ENOENT"
        ) {
          throw new Error(
            "AGENTIC_OPENCODE_LIVE_E2E is enabled but opencode was not found on PATH",
          );
        }
        expect(version.outcome).toEqual({ kind: "completed", code: 0 });

        const agent = new OpenCodeAdapter(runner, {
          ...(LIVE_MODEL === undefined ? {} : { model: LIVE_MODEL }),
        });
        const liveOrchestrator = createSingleTaskOrchestrator({
          store,
          git,
          agent,
          verification: createVerificationEngine({ runner }),
          verificationChecks: VERIFICATION_CHECKS,
          projectRoot: repoPath,
          worktreesDir,
          agentTimeoutMs: 15 * 60 * 1000,
        });
        const outcome = await liveOrchestrator.run(TASK_ID);
        expectCompleted(outcome);
        expect(await store.getTaskStatus(TASK_ID)).toBe("DONE");
        expect(outcome.integration.kind).toBe("fast-forward");
        expect(readFileSync(join(repoPath, CLAMP_SOURCE), "utf8")).toContain(
          "clamp",
        );
        expect((await git.status(repoPath)).clean).toBe(true);
      }, LIVE_E2E_TIMEOUT_MS);
    },
  );
});
