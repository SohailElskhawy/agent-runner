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
import { createAttempt, createProject, createTask, insertTaskRow } from "./fixtures.js";

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

  it("renews only the exact active execution lease and never lets a second coordinator steal it", async () => {
    const first = await claim(store, "M001", "exec-live", 2, ["shared"]);
    expect(first.kind).toBe("claimed");
    expect(await store.renewTaskExecution(
      "exec-live",
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:40.000Z",
    )).toBe(true);
    const claims = await store.listExecutionClaims({ status: "ACTIVE" });
    expect(claims[0]).toMatchObject({
      id: "exec-live",
      renewedAt: "2026-01-01T00:00:10.000Z",
      leaseExpiresAt: "2026-01-01T00:00:40.000Z",
    });
    expect((await claim(store, "M001", "exec-second", 2, ["shared"])).kind).toBe("already-claimed");
    expect(await store.renewTaskExecution(
      "exec-second",
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:40.000Z",
    )).toBe(false);
  });

  it("allows exactly one recovery owner to claim an expired execution", async () => {
    const claimed = await claim(store, "M002", "exec-expired", 2, ["recovery-resource"]);
    expect(claimed.kind).toBe("claimed");
    const other = createSqliteRunnerStore({ path: dbPath });
    await other.initialize();
    try {
      const results = await Promise.all([
        store.claimExpiredExecutionRecovery(
          "exec-expired", "recovery-a", "2026-01-01T00:01:00.000Z", "2026-01-01T00:02:00.000Z",
        ),
        other.claimExpiredExecutionRecovery(
          "exec-expired", "recovery-b", "2026-01-01T00:01:00.000Z", "2026-01-01T00:02:00.000Z",
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.listResourceLocks({ executionId: "exec-expired" })).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("rejects stale recovery settlement after ownership expires", async () => {
    await claim(store, "M003", "exec-stale", 2, ["stale-resource"]);
    expect(await store.claimExpiredExecutionRecovery(
      "exec-stale", "recovery-a", "2026-01-01T00:01:00.000Z", "2026-01-01T00:01:01.000Z",
    )).toBe(true);
    expect(await store.claimExpiredExecutionRecovery(
      "exec-stale", "recovery-b", "2026-01-01T00:01:02.000Z", "2026-01-01T00:02:00.000Z",
    )).toBe(true);
    expect(await store.releaseRecoveredTaskExecution(
      "exec-stale", "recovery-a", "FAILED", "2026-01-01T00:01:02.000Z",
    )).toBe(false);
    expect(await store.listResourceLocks({ executionId: "exec-stale" })).toHaveLength(1);
    expect(await store.releaseRecoveredTaskExecution(
      "exec-stale", "recovery-b", "FAILED", "2026-01-01T00:01:03.000Z",
    )).toBe(true);
    expect(await store.listResourceLocks({ executionId: "exec-stale" })).toEqual([]);
  });

  it("rejects normal settlement when the execution lease has expired", async () => {
    await claim(store, "M001", "exec-expired-settle", 2, ["resource-expired"]);
    const settled = await store.releaseTaskExecution(
      "exec-expired-settle",
      "COMPLETED",
      "2026-01-01T00:00:31.000Z",
    );
    expect(settled).toBe(false);
    expect((await store.listExecutionClaims({ status: "ACTIVE" })).map((c) => c.id)).toContain("exec-expired-settle");
    expect(await store.listResourceLocks({ executionId: "exec-expired-settle" })).toHaveLength(1);
  });

  it("rejects normal settlement when recovery owns the claim", async () => {
    await claim(store, "M002", "exec-recovery-collision", 2, ["resource-collision"]);
    expect(await store.claimExpiredExecutionRecovery(
      "exec-recovery-collision",
      "recovery-actor-b",
      "2026-01-01T00:00:31.000Z",
      "2026-01-01T00:01:00.000Z",
    )).toBe(true);
    const settled = await store.releaseTaskExecution(
      "exec-recovery-collision",
      "COMPLETED",
      "2026-01-01T00:00:32.000Z",
    );
    expect(settled).toBe(false);
    const claimRow = (await store.listExecutionClaims({ status: "ACTIVE" })).find((c) => c.id === "exec-recovery-collision");
    expect(claimRow).toBeDefined();
    expect(claimRow?.status).toBe("ACTIVE");
    expect(await store.listResourceLocks({ executionId: "exec-recovery-collision" })).toHaveLength(1);
    expect(await store.releaseRecoveredTaskExecution(
      "exec-recovery-collision",
      "recovery-actor-b",
      "COMPLETED",
      "2026-01-01T00:00:33.000Z",
    )).toBe(true);
    expect(await store.listResourceLocks({ executionId: "exec-recovery-collision" })).toEqual([]);
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
    insertTaskRow(dbPath, createTask({ id: "M001", status: "READY" }));
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
    expect(SCHEMA_VERSION).toBe(10);
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
      leaseExpiresAt: "2026-01-01T00:00:30.000Z",
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
    leaseExpiresAt: "2026-01-01T00:00:30.000Z",
  });
}

function clock(): string {
  return "2026-01-01T00:00:00.000Z";
}
