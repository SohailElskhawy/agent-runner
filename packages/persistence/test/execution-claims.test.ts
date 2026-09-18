import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import {
  createSqliteRunnerStore,
  SCHEMA_MIGRATIONS,
  SCHEMA_VERSION,
} from "@agentic-dev-runner/persistence";
import { createAttempt, createProject, createTask } from "./fixtures.js";

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

  it("upgrades a pre-claim database without losing locks or queue entries", async () => {
    await store.close();
    dbPath = join(directory, "upgrade-state.db");
    const legacy = createSqliteRunnerStore({
      path: dbPath,
      migrations: SCHEMA_MIGRATIONS.slice(0, 5),
    });
    const legacyAttempt = createAttempt({ id: "att_M001_1", taskId: "M001" });
    await legacy.initialize();
    await legacy.putProject(createProject());
    await legacy.putTask(createTask({ id: "M001", status: "READY" }));
    await legacy.putAttempt(legacyAttempt);
    await legacy.acquireResourceLocks([
      {
        resource: "legacy-resource",
        taskId: "M001",
        attemptId: legacyAttempt.id,
      },
    ]);
    await legacy.close();
    const legacyDb = new DatabaseSync(dbPath);
    try {
      legacyDb
        .prepare(
          `INSERT INTO integration_queue
           (id, task_id, attempt_id, task_revision, branch, base_revision, status, enqueued_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(
          "legacy-queue-entry",
          "M001",
          legacyAttempt.id,
          "legacy-task-revision",
          "task/M001/attempt-1",
          "legacy-base",
          clock(),
        );
    } finally {
      legacyDb.close();
    }

    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    expect(SCHEMA_VERSION).toBe(7);
    const oldLock = (await store.listResourceLocks())[0];
    expect(oldLock).toMatchObject({
      resource: "legacy-resource",
      taskId: "M001",
      attemptId: legacyAttempt.id,
    });
    expect(oldLock?.executionId).toBeUndefined();
    const oldQueue = (await store.listIntegrationQueueEntries())[0];
    expect(oldQueue?.executionId).toBeUndefined();

    const claim = await store.claimTaskExecution({
      taskId: "M001",
      executionId: "exec-after-upgrade",
      maxParallelism: 2,
      resources: ["new-resource"],
      claimedAt: clock(),
    });
    expect(claim.kind).toBe("claimed");
    expect(
      (await store.listResourceLocks({ executionId: "exec-after-upgrade" }))
        .map((lock) => lock.resource),
    ).toEqual(["new-resource"]);
    await store.releaseTaskExecution("exec-after-upgrade", "COMPLETED", clock());

    await store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
        version?: number | bigint;
      };
      expect(Number(row.version)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
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
