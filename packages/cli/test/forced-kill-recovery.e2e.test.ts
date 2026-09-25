import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import {
  projectKey,
  STATE_DB_FILE_NAME,
  STATE_ROOT_SEGMENT,
} from "../src/application/defaults.js";

const BUNDLE = fileURLToPath(
  new URL("../../agentic-dev-runner/bundle/main.js", import.meta.url),
);
const BUNDLE_SCRIPT = fileURLToPath(
  new URL("../../agentic-dev-runner/scripts/bundle.mjs", import.meta.url),
);
const KILL_AGENT_FIXTURE = fileURLToPath(
  new URL("./fixtures/fake-opencode-kill-agent.mjs", import.meta.url),
);
const SLOW_CHECK_FIXTURE = fileURLToPath(
  new URL("./fixtures/slow-verification-check.mjs", import.meta.url),
);

describe("forced-kill recovery", { timeout: 120_000 }, () => {
  let testDir: string;
  let homeDir: string;
  let repoDir: string;
  let shimDir: string;
  let childEnv: NodeJS.ProcessEnv;
  let storePath: string;

  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      execFileSync(process.execPath, [BUNDLE_SCRIPT], {
        cwd: dirname(BUNDLE_SCRIPT),
        stdio: "inherit",
      });
    }
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "agentic-forced-kill-"));
    homeDir = join(testDir, "home");
    repoDir = join(testDir, "repo");
    shimDir = join(testDir, "shims");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });

    if (process.platform === "win32") {
      writeFileSync(
        join(shimDir, "opencode.cmd"),
        `@echo off\r\nnode "${KILL_AGENT_FIXTURE}" %*\r\n`,
      );
    } else {
      const shim = join(shimDir, "opencode");
      writeFileSync(shim, `#!/bin/sh\nexec node "${KILL_AGENT_FIXTURE}" "$@"\n`);
      execFileSync("chmod", ["+x", shim]);
    }

    childEnv = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      AGENTIC_KILL_REPO_ROOT: repoDir,
      PATH: `${shimDir}${delimiter}${process.env["PATH"] ?? ""}`,
    };

    storePath = join(
      homeDir,
      STATE_ROOT_SEGMENT,
      projectKey(repoDir),
      STATE_DB_FILE_NAME,
    );
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for Windows file locks
    }
  });

  function spawnCli(
    repository: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): ChildProcess {
    return spawn(process.execPath, [BUNDLE, ...args], {
      cwd: repository,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  function runCliSync(
    repository: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): string {
    return execFileSync(process.execPath, [BUNDLE, ...args], {
      cwd: repository,
      env,
      encoding: "utf8",
    });
  }

  function killTree(child: ChildProcess): void {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // Child may have already exited
      }
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may have already exited
      }
    }
  }

  function waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
      child.once("exit", () => resolve());
    });
  }

  async function poll(
    predicate: () => boolean | Promise<boolean>,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const intervalMs = options.intervalMs ?? 50;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`poll timed out after ${String(timeoutMs)}ms`);
  }

  function runGit(repository: string, args: readonly string[]): string {
    return execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
    }).trim();
  }

  function initializeRepository(
    repositoryPath: string,
    projectConfigYaml: string,
  ): void {
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, "AGENTS.md"), "# Fixture rules\n");
    writeFileSync(join(repositoryPath, "README.md"), "# Fixture repository\n");
    writeFileSync(
      join(repositoryPath, ".gitignore"),
      ".kill-marker-*\n.slow-verification-marker\n",
    );
    writeFileSync(join(repositoryPath, "agentic.yaml"), projectConfigYaml);
    runGit(repositoryPath, ["init"]);
    runGit(repositoryPath, ["config", "user.email", "runner@example.com"]);
    runGit(repositoryPath, ["config", "user.name", "Agentic Runner"]);
    runGit(repositoryPath, ["config", "core.autocrlf", "false"]);
    runGit(repositoryPath, ["add", "."]);
    runGit(repositoryPath, ["commit", "-m", "initial commit"]);
  }

  function makeTaskJson(options: {
    taskId: string;
    title: string;
    checks: readonly string[];
  }): string {
    return JSON.stringify(
      {
        id: options.taskId,
        title: options.title,
        milestone: "forced-kill-recovery",
        status: "ready",
        priority: "P0",
        risk: "low",
        type: "implementation",
        objective: `Create src/kill/${options.taskId}.cjs and test/kill/${options.taskId}.test.cjs`,
        acceptance_criteria: [`src/kill/${options.taskId}.cjs exports value`],
        depends_on: [],
        provenance: { kind: "user_request", source: "manual" },
        scope: {
          allowed_paths: [
            `src/kill/${options.taskId}.cjs`,
            `test/kill/${options.taskId}.test.cjs`,
          ],
          forbidden_paths: [],
        },
        resources: [`resource-${options.taskId}`],
        workflow: "simple",
        routing: { complexity: "small", capabilities: ["javascript"] },
        verification: { required: options.checks },
        limits: { max_attempts: 3, max_review_cycles: 2 },
        approval: { required: false },
      },
      null,
      2,
    );
  }

  it(
    "recovers from a forced kill during agent execution without duplicate merges or orphaned claims",
    async () => {
      const configYaml = [
        "verification:",
        "  checks:",
        "    unit:",
        "      command: node",
        "      args:",
        "        - --test",
        "        - test/**/*.test.cjs",
        "agents:",
        "  profiles:",
        "    opencode:",
        "      adapter: opencode",
        "      capabilities:",
        "        - javascript",
      ].join("\n");

      initializeRepository(repoDir, configYaml);

      runCliSync(repoDir, ["init"], childEnv);

      const taskFile = join(testDir, "task-k1.json");
      writeFileSync(
        taskFile,
        makeTaskJson({
          taskId: "K1",
          title: "Agent execution kill recovery",
          checks: ["unit"],
        }),
      );
      runCliSync(repoDir, ["tasks", "add", taskFile], childEnv);

      // Start run K1 (unattended single runnable task)
      const child = spawnCli(repoDir, ["run", "K1"], childEnv);

      // Poll for .kill-marker-K1
      const marker = join(repoDir, ".kill-marker-K1");
      await poll(() => existsSync(marker));

      // Force kill
      killTree(child);
      await waitForExit(child);

      // Spawn status (must exit 0)
      const statusOutput = runCliSync(repoDir, ["status"], childEnv);
      expect(statusOutput).toContain("K1");

      // Spawn run again (recovery + attempt 2 writes files)
      const runAgainOutput = runCliSync(repoDir, ["run"], childEnv);
      expect(runAgainOutput).toContain("quiescence");

      // Verify status contains 1 DONE
      const finalStatus = runCliSync(repoDir, ["status"], childEnv);
      expect(finalStatus).toContain("1 DONE");

      // Verify git commits: exactly 2 (initial commit + 1 task commit)
      expect(runGit(repoDir, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(runGit(repoDir, ["log", "--format=%s"])).toContain(
        "task K1: Agent execution kill recovery",
      );

      // Store checks: no ACTIVE claims, recovery events exist
      const store = createSqliteRunnerStore({ path: storePath });
      try {
        await store.initialize();
        const activeClaims = await store.listExecutionClaims({
          status: "ACTIVE",
        });
        expect(activeClaims).toHaveLength(0);

        const events = await store.listEvents({ taskId: "K1" });
        const reconciled = events.some((e) => e.type === "recovery.reconciled");
        expect(reconciled).toBe(true);

        const allEvents = await store.listEvents();
        const hasStartupRecovery = allEvents.some((e) =>
          e.type.startsWith("recovery.startup."),
        );
        expect(hasStartupRecovery).toBe(true);
      } finally {
        await store.close();
      }
    },
    120_000,
  );

  it(
    "recovers from a forced kill during integration verification without duplicate merges or queue stalls",
    async () => {
      // Place the slow verification check into repository fixtures
      const fixturesDir = join(repoDir, "fixtures");
      mkdirSync(fixturesDir, { recursive: true });
      copyFileSync(
        SLOW_CHECK_FIXTURE,
        join(fixturesDir, "slow-verification-check.mjs"),
      );

      const configYaml = [
        "verification:",
        "  checks:",
        "    unit:",
        "      command: node",
        "      args:",
        "        - --test",
        "        - test/**/*.test.cjs",
        "    slow:",
        "      command: node",
        "      args:",
        "        - fixtures/slow-verification-check.mjs",
        "agents:",
        "  profiles:",
        "    opencode:",
        "      adapter: opencode",
        "      capabilities:",
        "        - javascript",
      ].join("\n");

      initializeRepository(repoDir, configYaml);

      runCliSync(repoDir, ["init"], childEnv);

      const taskFile = join(testDir, "task-k2.json");
      writeFileSync(
        taskFile,
        makeTaskJson({
          taskId: "K2",
          title: "Integration verification kill recovery",
          checks: ["unit", "slow"],
        }),
      );
      runCliSync(repoDir, ["tasks", "add", taskFile], childEnv);

      // Start run K2
      const child = spawnCli(repoDir, ["run", "K2"], childEnv);

      // Poll until git log in the repository contains task K2: (merge happened)
      await poll(() => {
        try {
          const log = runGit(repoDir, ["log", "--format=%s"]);
          return log.includes("task K2:");
        } catch {
          return false;
        }
      });

      // Kill the runner while it is waiting in slow integration verification
      killTree(child);
      await waitForExit(child);

      // Restart with run
      const restartOutput = runCliSync(repoDir, ["run"], childEnv);
      expect(restartOutput).toContain("quiescence");

      // Assert final 1 DONE
      const finalStatus = runCliSync(repoDir, ["status"], childEnv);
      expect(finalStatus).toContain("1 DONE");

      // rev-list --count HEAD == 2 (no duplicate commit/merge)
      expect(runGit(repoDir, ["rev-list", "--count", "HEAD"])).toBe("2");

      // Store checks: one integration.completed event for K2, no INTEGRATING entries
      const store = createSqliteRunnerStore({ path: storePath });
      try {
        await store.initialize();
        const events = await store.listEvents({ taskId: "K2" });
        const integrationCompletedEvents = events.filter(
          (e) => e.type === "integration.completed",
        );
        expect(integrationCompletedEvents).toHaveLength(1);

        const integratingEntries = await store.listIntegrationQueueEntries({
          taskId: "K2",
          status: "INTEGRATING",
        });
        expect(integratingEntries).toHaveLength(0);
      } finally {
        await store.close();
      }
    },
    120_000,
  );
});
