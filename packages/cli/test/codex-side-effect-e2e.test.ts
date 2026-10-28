import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, type AgentRegistry } from "@agentic-dev-runner/agents";
import { createSqliteRunnerStore, type RunnerStore } from "@agentic-dev-runner/persistence";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { createAppServices } from "../src/application/app-services.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { resolveStorePath } from "../src/application/defaults.js";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { runCli } from "../src/run-cli.js";
import { captureIo, createFixtureTask } from "./fixtures.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-side-effect.mjs", import.meta.url));
const agents: AgentRegistry = {
  agentIds: ["codex"],
  async discoverAgents() { return [{ id: "codex", available: true, version: "fixture", reason: null }]; },
};
const config = [
  "verification:", "  checks:", "    unit:", "      command: node", "      args:", "        - --check", "        - src/report.mjs",
  "agents:", "  profiles:", "    fixture:", "      adapter: codex", "      capabilities:", "        - typescript", "",
].join("\n");

describe("Codex child side effects at the workflow scope gate", () => {
  let directory: string;
  let repo: string;
  let state: string;
  let store: RunnerStore | undefined;
  const runner = createNodeProcessRunner();

  async function git(args: string[], cwd = repo): Promise<string> {
    const result = await runner.run({ executable: "git", args, cwd });
    if (result.outcome.kind !== "completed" || result.outcome.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  beforeEach(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "codex-side-effect-")));
    repo = join(directory, "fixture repo");
    state = join(directory, "runner state");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "# Fixture\n");
    writeFileSync(join(repo, "agentic.yaml"), config);
    await git(["init"]);
    await git(["config", "user.email", "runner@example.com"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "core.autocrlf", "false"]);
    await git(["add", "."]);
    await git(["commit", "-m", "seed"]);
  });
  afterEach(async () => {
    await store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  async function run(mode: "allowed" | "unexpected") {
    const adapter = new CodexAdapter(runner, { executable: process.execPath, launcherArgs: [fixture, mode] });
    const servicesFactory = async () => {
      const app = await createAppServices({ projectRoot: repo, stateDir: state, agentTimeoutMs: 60_000 }, {
        agentRegistry: agents, agentAdapters: createAgentAdapterRegistry([adapter]),
      });
      return createStoreBackedAppService({
        storePath: resolveStorePath({ projectRoot: repo, stateDir: state }), projectRoot: repo,
        store: app.store, orchestrator: app.orchestrator, recovery: app.recovery, agents: app.agents,
        scheduler: app.scheduler, maxParallelism: app.maxParallelism,
      });
    };
    const init = captureIo();
    expect(await runCli(["init"], { io: init.io, servicesFactory })).toBe(0);
    store = createSqliteRunnerStore({ path: resolveStorePath({ projectRoot: repo, stateDir: state }) });
    await store.initialize();
    const task = createFixtureTask({ id: "S1" });
    await store.putTask({ ...task, workflow: "simple", definition: { ...task.definition, verification: { required: ["unit"] }, limits: { maxAttempts: 1, maxReviewCycles: 1 } } });
    await store.close();
    store = undefined;
    const io = captureIo();
    const exit = await runCli(["run", "--parallel", "1"], { io: io.io, servicesFactory });
    store = createSqliteRunnerStore({ path: resolveStorePath({ projectRoot: repo, stateDir: state }) });
    await store.initialize();
    return { exit, io, store };
  }

  it.each(["unexpected", "allowed"] as const)("handles %s child output", async (mode) => {
    const base = await git(["rev-parse", "HEAD"]);
    expect(await git(["ls-tree", "-r", "--name-only", "HEAD", "--", "src/report.mjs", ".serena/project.yml"])).toBe("");
    const result = await run(mode);
    const attempt = (await result.store.listAttempts({ taskId: "S1" }))[0];
    expect(attempt).toBeDefined();
    const stages = await result.store.listStageRuns(attempt!.id);
    const events = await result.store.listEvents({ taskId: "S1" });
    const queue = await result.store.listIntegrationQueueEntries();
    const worktree = join(state, "worktrees", "S1", "attempt-1");
    const output = JSON.parse(stages.find((stage) => stage.stage === "IMPLEMENT")?.output?.stdout ?? "null");
    expect(output.cwd).toBe(worktree);
    expect(output.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    if (mode === "unexpected") {
      expect(result.exit, result.io.errors.join("\n")).toBe(0);
      expect((await result.store.getTask("S1"))?.status).toBe("FAILED");
      expect(attempt?.failure?.message).toContain(".serena/project.yml (no allowed path pattern matched)");
      expect(stages.map((stage) => stage.stage)).toEqual(["IMPLEMENT"]);
      expect(stages[0]?.status).toBe("SUCCEEDED");
      expect(events.map((event) => event.type)).not.toContain("verification.completed");
      expect(events.map((event) => event.type)).not.toContain("commit.created");
      expect(events.map((event) => event.type)).not.toContain("integration.completed");
      expect(queue).toEqual([]);
      const transitions = events.filter((event) => event.type === "task.transitioned").map((event) => (event.payload as { to: string }).to);
      expect(transitions).not.toContain("VERIFYING");
      expect(transitions).not.toContain("INTEGRATING");
      expect(transitions).not.toContain("DONE");
      expect(existsSync(worktree)).toBe(true);
      expect(readFileSync(join(worktree, ".serena", "project.yml"), "utf8")).toBe("fixture: retained\n");
      expect(readFileSync(join(worktree, "src", "report.mjs"), "utf8")).toBe("export const report = 'fixture';\n");
      expect(await git(["show", ":.serena/project.yml"], worktree)).toBe("fixture: retained");
      expect((await git(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")).toContain(`worktree ${worktree.replaceAll("\\", "/")}`);
      expect(await git(["rev-parse", "HEAD"], worktree)).toBe(base);
      expect(await git(["rev-parse", "HEAD"])).toBe(base);
    } else {
      expect(result.exit, result.io.errors.join("\n")).toBe(0);
      expect((await result.store.getTask("S1"))?.status).toBe("DONE");
      expect(stages.map((stage) => stage.stage)).toEqual(["IMPLEMENT", "VERIFY", "INTEGRATE"]);
      expect(queue.map((entry) => entry.status)).toEqual(["COMPLETED"]);
      expect(events.map((event) => event.type)).toContain("integration.verification.completed");
      expect(readFileSync(join(repo, "src", "report.mjs"), "utf8")).toBe("export const report = 'fixture';\n");
    }
  }, 60_000);
});
