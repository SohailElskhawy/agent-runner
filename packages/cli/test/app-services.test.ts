import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SingleTaskRunOutcome } from "@agentic-dev-runner/orchestrator";
import type { SingleTaskOrchestrator } from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createAppServices } from "../src/application/app-services.js";
import {
  defaultStateDir,
  projectKey,
  resolveAgentTimeoutMs,
  resolveStorePath,
  resolveWorktreesDir,
  type AppServicesOptions,
} from "../src/application/defaults.js";
import { createFixtureProject, temporaryDirectory } from "./fixtures.js";

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

  it("creates a real SQLite store whose state survives reopening", async () => {
    const appServices = createAppServices(options, {
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
    const appServices = createAppServices(options, { orchestrator });
    store = appServices.store;

    const outcome = await appServices.orchestrator.run("M001");

    expect(orchestrator.calls).toEqual(["M001"]);
    expect(outcome.kind).toBe("rejected");
  });

  it("uses the default agent timeout when not overridden", () => {
    expect(resolveAgentTimeoutMs({ projectRoot: "x" })).toBe(15 * 60 * 1000);
    expect(resolveAgentTimeoutMs({ projectRoot: "x", agentTimeoutMs: 42 })).toBe(42);
  });
});
