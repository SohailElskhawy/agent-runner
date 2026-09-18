import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SingleTaskRunOutcome } from "@agentic-dev-runner/orchestrator";
import type { SingleTaskOrchestrator } from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createAppServices } from "../src/application/app-services.js";
import { createServices } from "../src/wiring.js";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import {
  defaultStateDir,
  normalizeProjectRootForIdentity,
  projectKey,
  resolveAgentTimeoutMs,
  resolveProjectRoot,
  resolveStorePath,
  resolveVerificationChecks,
  resolveWorktreesDir,
  type AppServicesOptions,
} from "../src/application/defaults.js";
import { createFixtureProject, temporaryDirectory, writeProjectConfiguration } from "./fixtures.js";

const CASE_INSENSITIVE_PLATFORM = process.platform === "win32" || process.platform === "darwin";

class RecordingOrchestrator implements SingleTaskOrchestrator {
  readonly calls: string[] = [];
  constructor(private readonly outcome: SingleTaskRunOutcome) {}
  async run(taskId: string): Promise<SingleTaskRunOutcome> {
    this.calls.push(taskId);
    return this.outcome;
  }
}

const rejectedOutcome: SingleTaskRunOutcome = {
  kind: "rejected",
  taskId: "M001",
  reason: "task is not runnable",
};

describe("createAppServices wiring", () => {
  let directory: string;
  let options: AppServicesOptions;
  let store: RunnerStore;

  beforeEach(() => {
    directory = temporaryDirectory("agentic-cli-wiring");
    writeProjectConfiguration(directory);
    options = { projectRoot: directory };
  });

  afterEach(async () => {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("resolves the store path below the per-project state directory", () => {
    const stateDir = defaultStateDir(directory);
    expect(stateDir).toBe(
      join(homedir(), ".agentic", "projects", projectKey(directory)),
    );
    expect(resolveStorePath(options)).toBe(join(stateDir, "state.db"));
    expect(
      resolveStorePath({
        projectRoot: directory,
        storePath: join(directory, "custom.db"),
      }),
    ).toBe(join(directory, "custom.db"));
  });

  it("keeps the worktrees directory outside the repository", () => {
    expect(resolveStorePath({ projectRoot: directory })).not.toContain(directory);
    expect(resolveWorktreesDir({ projectRoot: directory })).not.toContain(directory);
  });

  it("resolves project roots to absolute normalized paths", () => {
    expect(resolveProjectRoot(directory)).toBe(resolve(directory));
    expect(resolveProjectRoot(".")).toBe(resolve(process.cwd()));
  });

  it("normalizes path representation before identity hashing", () => {
    expect(projectKey(directory)).toBe(projectKey(resolve(directory)));
    expect(projectKey(directory)).toBe(projectKey(directory + sep));
    expect(projectKey(directory)).toBe(projectKey(join(directory, ".")));
    if (CASE_INSENSITIVE_PLATFORM) {
      expect(normalizeProjectRootForIdentity(directory)).toBe(
        resolve(directory).toLowerCase(),
      );
    } else {
      expect(normalizeProjectRootForIdentity(directory)).toBe(resolve(directory));
    }
  });

  it("folds path casing on case-insensitive platforms only", () => {
    const upper = directory.toUpperCase();
    const lower = directory.toLowerCase();
    if (CASE_INSENSITIVE_PLATFORM) {
      expect(projectKey(upper)).toBe(projectKey(lower));
      expect(defaultStateDir(upper)).toBe(defaultStateDir(lower));
      expect(normalizeProjectRootForIdentity(upper)).toBe(
        normalizeProjectRootForIdentity(lower),
      );
    } else {
      expect(projectKey(upper)).not.toBe(projectKey(lower));
    }
  });

  it("returns no fabricated verification checks by default", () => {
    expect(resolveVerificationChecks({ projectRoot: directory })).toEqual([]);
    const explicit = [{ name: "typecheck", executable: "node", args: ["--version"] }];
    expect(
      resolveVerificationChecks({ projectRoot: directory, verificationChecks: explicit }),
    ).toEqual(explicit);
  });

  it("creates a real SQLite store whose state survives reopening", async () => {
    const appServices = await createAppServices(options, {
      orchestrator: new RecordingOrchestrator(rejectedOutcome),
    });
    store = appServices.store;
    await store.initialize();
    await store.putProject(createFixtureProject());
    await store.close();

    const reopened = createSqliteRunnerStore({ path: resolveStorePath(options) });
    try {
      await reopened.initialize();
      expect(await reopened.listProjects()).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  it("delegates run to the provided orchestrator override", async () => {
    const orchestrator = new RecordingOrchestrator(rejectedOutcome);
    const appServices = await createAppServices(options, { orchestrator });
    store = appServices.store;

    const outcome = await appServices.orchestrator.run("M001");

    expect(orchestrator.calls).toEqual(["M001"]);
    expect(outcome.kind).toBe("rejected");
  });

  it("uses the default agent timeout when not overridden", () => {
    expect(resolveAgentTimeoutMs({ projectRoot: "x" })).toBe(15 * 60 * 1000);
    expect(resolveAgentTimeoutMs({ projectRoot: "x", agentTimeoutMs: 42 })).toBe(42);
  });

  it("wires a default agent registry containing the built-in coding agents", async () => {
    const appServices = await createAppServices(options);
    store = appServices.store;

    expect(appServices.agents.agentIds).toEqual(["opencode", "codex"]);
  });

  it("exposes the production unattended scheduler composition", async () => {
    const appServices = await createAppServices({
      ...options,
      maxParallelism: 2,
    });
    store = appServices.store;

    expect(appServices.scheduler).not.toBeNull();
  });

  it("connects createServices to the application unattended operation", async () => {
    const previousProfile = process.env.USERPROFILE;
    const profile = temporaryDirectory("agentic-unattended-profile");
    process.env.USERPROFILE = profile;
    try {
      const services = await createServices(directory);
      try {
        const result = await services.runUnattended();
        expect(result.kind).toBe("completed");
      } finally {
        await services.close();
      }
    } finally {
      if (previousProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousProfile;
      }
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("accepts an agent registry override for testing", async () => {
    const registry = {
      agentIds: ["fake"],
      async discoverAgents() {
        return [];
      },
    };
    const appServices = await createAppServices(options, { agentRegistry: registry });
    store = appServices.store;

    expect(appServices.agents).toBe(registry);
  });

  it("wires a default adapter registry covering the built-in coding adapters", async () => {
    const appServices = await createAppServices(options);
    store = appServices.store;

    expect(appServices.adapters.adapterIds).toEqual(["opencode", "codex"]);
    expect(appServices.adapters.resolveAdapter("opencode")).not.toBeNull();
    expect(appServices.adapters.resolveAdapter("codex")).not.toBeNull();
    expect(appServices.adapters.resolveAdapter("claude")).toBeNull();
  });

  it("accepts an adapter registry override for testing", async () => {
    const adapters = createAgentAdapterRegistry([]);
    const appServices = await createAppServices(options, { agentAdapters: adapters });
    store = appServices.store;

    expect(appServices.adapters).toBe(adapters);
  });
});
