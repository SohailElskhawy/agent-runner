import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceLock } from "@agentic-dev-runner/core";
import { createSqliteRunnerStore, PersistenceError } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createProject, createTask } from "./fixtures.js";

describe("SqliteRunnerStore resource locks (M045a)", () => {
  let directory: string;
  let dbPath: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m045a-"));
    dbPath = join(directory, "state.db");
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask());
    await store.putTask(createTask({ id: "M002" }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const lock = (
    resource: string,
    taskId: string,
    overrides?: {
      attemptId?: string;
      acquiredAt?: string;
    },
  ): ResourceLock => ({
    resource,
    taskId,
    ...(overrides?.attemptId === undefined
      ? {}
      : { attemptId: overrides.attemptId }),
    ...(overrides?.acquiredAt === undefined
      ? {}
      : { acquiredAt: overrides.acquiredAt }),
  });

  it("starts with no held resource locks", async () => {
    expect(await store.listResourceLocks()).toEqual([]);
  });

  it("acquires a single lock and reads it back with its ownership", async () => {
    await store.acquireResourceLocks([
      lock("database-schema", "M001", {
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(await store.listResourceLocks()).toEqual([
      {
        resource: "database-schema",
        taskId: "M001",
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("acquires multiple locks atomically in one call", async () => {
    await store.acquireResourceLocks([
      lock("routing", "M001"),
      lock("auth-state", "M001"),
      lock("payments", "M001"),
    ]);

    expect((await store.listResourceLocks()).map((held) => held.resource)).toEqual([
      "auth-state",
      "payments",
      "routing",
    ]);
  });

  it("mutates nothing when one of several resources is held by another task", async () => {
    await store.putTask(createTask({ id: "M009" }));
    await store.acquireResourceLocks([lock("payments", "M009")]);

    await expect(
      store.acquireResourceLocks([
        lock("auth-state", "M001"),
        lock("payments", "M001"),
      ]),
    ).rejects.toThrow(PersistenceError);

    expect((await store.listResourceLocks()).map((held) => held.resource)).toEqual([
      "payments",
    ]);
    const payments = (await store.listResourceLocks())[0];
    expect(payments?.taskId).toBe("M009");
  });

  it("rejects a second task acquiring a held resource", async () => {
    await store.acquireResourceLocks([
      lock("database-schema", "M001", { attemptId: "att_M001_1" }),
    ]);

    await expect(
      store.acquireResourceLocks([lock("database-schema", "M002")]),
    ).rejects.toThrow(/already held by task "M001"/);
  });

  it("treats re-acquisition by the same owner as an idempotent no-op", async () => {
    await store.acquireResourceLocks([
      lock("database-schema", "M001", {
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    await store.acquireResourceLocks([
      lock("database-schema", "M001", {
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-02T00:00:00.000Z",
      }),
      lock("routing", "M001", { attemptId: "att_M001_1" }),
    ]);

    expect(await store.listResourceLocks()).toEqual([
      {
        resource: "database-schema",
        taskId: "M001",
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
      { resource: "routing", taskId: "M001", attemptId: "att_M001_1" },
    ]);
  });

  it("rejects duplicate acquisition requests with conflicting ownership", async () => {
    await expect(
      store.acquireResourceLocks([
        lock("database-schema", "M001"),
        lock("database-schema", "M002"),
      ]),
    ).rejects.toThrow(/conflicting ownership/);
  });

  it("never lets two tasks hold unrelated resources blocked by exclusivity of each resource", async () => {
    await store.acquireResourceLocks([lock("auth-state", "M001")]);

    await expect(
      store.acquireResourceLocks([lock("auth-state", "M002")]),
    ).rejects.toThrow(PersistenceError);

    await store.acquireResourceLocks([lock("payments", "M002")]);
    expect((await store.listResourceLocks()).map((held) => held.resource)).toEqual([
      "auth-state",
      "payments",
    ]);
  });

  it("releases exactly the locks owned by a filter", async () => {
    await store.acquireResourceLocks([
      lock("auth-state", "M001", { attemptId: "att_M001_1" }),
      lock("routing", "M001", { attemptId: "att_M001_2" }),
      lock("payments", "M002", { attemptId: "att_M002_1" }),
    ]);

    await store.releaseResourceLocks({ taskId: "M001", attemptId: "att_M001_1" });

    expect((await store.listResourceLocks()).map((held) => held.resource)).toEqual([
      "payments",
      "routing",
    ]);

    await store.releaseResourceLocks({ taskId: "M001" });

    expect((await store.listResourceLocks()).map((held) => held.resource)).toEqual([
      "payments",
    ]);
  });

  it("rejects releasing without an explicit ownership filter", async () => {
    await store.acquireResourceLocks([lock("auth-state", "M001")]);

    await expect(store.releaseResourceLocks({})).rejects.toThrow(
      PersistenceError,
    );
    expect(await store.listResourceLocks()).toHaveLength(1);
  });

  it("rejects acquiring a lock for an unknown owning task", async () => {
    await expect(
      store.acquireResourceLocks([lock("auth-state", "M999")]),
    ).rejects.toThrow(/does not exist/);
    expect(await store.listResourceLocks()).toEqual([]);
  });

  it("survives store reopen with the durable lock state intact", async () => {
    await store.acquireResourceLocks([
      lock("database-schema", "M001", {
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      expect(await reopened.listResourceLocks()).toEqual([
        {
          resource: "database-schema",
          taskId: "M001",
          attemptId: "att_M001_1",
          acquiredAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    } finally {
      await reopened.close();
    }
  });

  it("filters lock listings by task", async () => {
    await store.acquireResourceLocks([
      lock("auth-state", "M001"),
      lock("payments", "M002"),
    ]);

    expect((await store.listResourceLocks({ taskId: "M001" })).map((held) => held.resource)).toEqual([
      "auth-state",
    ]);
  });
});
