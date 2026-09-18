import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createProject, createTask } from "./fixtures.js";

describe("durable execution claims", () => {
  let directory: string;
  let dbPath: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-claims-"));
    dbPath = join(directory, "state.db");
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask({ id: "M001", status: "READY" }));
    await store.putTask(createTask({ id: "M002", status: "READY" }));
    await store.putTask(createTask({ id: "M003", status: "READY" }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("atomically protects zero-resource tasks and reserves global capacity", async () => {
    const other = createSqliteRunnerStore({ path: dbPath });
    await other.initialize();
    try {
      const results = await Promise.all([
        claim(other, "M001", "exec-a", 1, []),
        claim(store, "M001", "exec-b", 1, []),
      ]);

      expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "already-claimed")).toHaveLength(1);
      expect(await store.listExecutionClaims({ status: "ACTIVE" })).toHaveLength(1);

      const capacity = await claim(store, "M002", "exec-c", 1, []);
      expect(capacity.kind).toBe("capacity-exhausted");
    } finally {
      await other.close();
    }
  });

  it("owns and releases resource locks by unique execution identity", async () => {
    const result = await claim(store, "M003", "exec-resource", 2, ["shared"]);
    expect(result.kind).toBe("claimed");
    expect(await store.listResourceLocks()).toEqual([
      {
        resource: "shared",
        taskId: "M003",
        executionId: "exec-resource",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await store.releaseTaskExecution("exec-resource", "COMPLETED", clock());
    expect(await store.listResourceLocks()).toEqual([]);
    expect((await store.listExecutionClaims())[0]?.status).toBe("COMPLETED");
  });
});

async function claim(
  store: RunnerStore,
  taskId: string,
  executionId: string,
  maxParallelism: number,
  resources: readonly string[],
) {
  return await store.claimTaskExecution({
    taskId,
    executionId,
    maxParallelism,
    resources,
    claimedAt: clock(),
  });
}

function clock(): string {
  return "2026-01-01T00:00:00.000Z";
}
