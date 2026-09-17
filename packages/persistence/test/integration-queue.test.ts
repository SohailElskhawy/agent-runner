import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntegrationQueueEntry } from "@agentic-dev-runner/core";
import { createSqliteRunnerStore, PersistenceError } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createAttempt, createProject, createTask } from "./fixtures.js";

describe("SqliteRunnerStore integration queue (M047a)", () => {
  let directory: string;
  let dbPath: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m047a-"));
    dbPath = join(directory, "state.db");
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    await store.putProject(createProject());
    await store.putTask(createTask({ id: "M001" }));
    await store.putTask(createTask({ id: "M002" }));
    await store.putAttempt(createAttempt({ id: "att_M001_1", taskId: "M001" }));
    await store.putAttempt(createAttempt({ id: "att_M002_1", taskId: "M002" }));
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (
    taskId: string,
    attemptId: string,
    overrides?: {
      taskRevision?: string;
      branch?: string;
      baseRevision?: string;
      enqueuedAt?: string;
      id?: string;
    },
  ) => ({
    taskId,
    attemptId,
    taskRevision: overrides?.taskRevision ?? `rev_${taskId}`,
    branch: overrides?.branch ?? `task/${taskId}/attempt-1`,
    baseRevision: overrides?.baseRevision ?? "base_abc",
    enqueuedAt: overrides?.enqueuedAt ?? "2026-01-01T00:00:00.000Z",
    ...(overrides?.id === undefined ? {} : { id: overrides.id }),
  });

  const queuedIds = async () =>
    (await store.listIntegrationQueueEntries()).map((entry) => entry.taskId);

  it("starts with an empty integration queue", async () => {
    expect(await store.listIntegrationQueueEntries()).toEqual([]);
  });

  it("enqueues one prepared attempt as a pending entry", async () => {
    const entry = await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1"),
    );

    expect(entry.status).toBe("PENDING");
    expect(entry.sequence).toBe(1);
    expect(entry.claimedAt).toBeUndefined();
    expect(entry.finishedAt).toBeUndefined();
    expect(await store.listIntegrationQueueEntries()).toEqual([entry]);
  });

  it("enqueues multiple entries in enqueue order", async () => {
    await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1", { enqueuedAt: "2026-01-01T00:00:01.000Z" }),
    );
    await store.enqueueIntegrationQueueEntry(
      request("M002", "att_M002_1", { enqueuedAt: "2026-01-01T00:00:00.000Z" }),
    );

    expect(await queuedIds()).toEqual(["M001", "M002"]);
  });

  it("orders pending entries deterministically by enqueue sequence", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    await store.enqueueIntegrationQueueEntry(request("M002", "att_M002_1"));

    const listed = await store.listIntegrationQueueEntries();
    expect(listed.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect((await store.claimNextIntegrationQueueEntry("2026-01-01T00:01:00.000Z"))?.taskId)
      .toBe("M001");
  });

  it("rejects a duplicate active enqueue of the same task/attempt deterministically", async () => {
    const first = await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1"),
    );

    await expect(
      store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1")),
    ).rejects.toThrow(
      /active integration queue entry for task "M001" \(attempt "att_M001_1"\) already exists/,
    );

    expect(await store.listIntegrationQueueEntries()).toEqual([first]);

    await expect(
      store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1")),
    ).rejects.toThrow(PersistenceError);
    expect(await store.listIntegrationQueueEntries()).toHaveLength(1);
  });

  it("claims the first pending entry and marks it actively integrating", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));

    const claimed = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:01:00.000Z",
    );

    expect(claimed?.taskId).toBe("M001");
    expect(claimed?.status).toBe("INTEGRATING");
    expect(claimed?.claimedAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("lets a second claimant not claim the actively integrating entry", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    await store.enqueueIntegrationQueueEntry(request("M002", "att_M002_1"));
    await store.claimNextIntegrationQueueEntry("2026-01-01T00:01:00.000Z");

    const secondClaim = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:02:00.000Z",
    );

    expect(secondClaim).toBeNull();
    const entries = await store.listIntegrationQueueEntries();
    expect(
      entries.find((entry) => entry.taskId === "M002")?.status,
    ).toBe("PENDING");
  });

  it("returns null when the queue is empty", async () => {
    expect(await store.claimNextIntegrationQueueEntry("2026-01-01T00:01:00.000Z"))
      .toBeNull();
  });

  it("completing the active entry releases the queue for the next item", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    await store.enqueueIntegrationQueueEntry(request("M002", "att_M002_1"));
    const claimed = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:01:00.000Z",
    );

    await store.completeIntegrationQueueEntry(
      claimed?.id ?? "",
      "2026-01-01T00:05:00.000Z",
    );

    const next = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:06:00.000Z",
    );
    expect(next?.taskId).toBe("M002");

    const entries = await store.listIntegrationQueueEntries();
    const completed = entries.find((entry) => entry.taskId === "M001");
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.finishedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("failing the active entry releases the queue and preserves the failure", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    await store.enqueueIntegrationQueueEntry(request("M002", "att_M002_1"));
    const claimed = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:01:00.000Z",
    );

    await store.failIntegrationQueueEntry(
      claimed?.id ?? "",
      { message: "integration verification failed" },
      "2026-01-01T00:05:00.000Z",
    );

    const next = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:06:00.000Z",
    );
    expect(next?.taskId).toBe("M002");

    const failed = (await store.listIntegrationQueueEntries()).find(
      (entry) => entry.taskId === "M001",
    );
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failure).toEqual({ message: "integration verification failed" });
  });

  it("rejects completing or failing an entry that is not actively integrating", async () => {
    const entry = await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1"),
    );

    await expect(
      store.completeIntegrationQueueEntry(entry.id, "2026-01-01T00:05:00.000Z"),
    ).rejects.toThrow(/not actively integrating/);
    await expect(
      store.failIntegrationQueueEntry(
        entry.id,
        { message: "boom" },
        "2026-01-01T00:05:00.000Z",
      ),
    ).rejects.toThrow(/not actively integrating/);
    await expect(
      store.completeIntegrationQueueEntry("iq_missing", "2026-01-01T00:05:00.000Z"),
    ).rejects.toThrow(PersistenceError);
  });

  it("never deletes entries, so completed history stays inspectable", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    const claimed = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:01:00.000Z",
    );
    await store.completeIntegrationQueueEntry(
      claimed?.id ?? "",
      "2026-01-01T00:05:00.000Z",
    );

    const history = await store.listIntegrationQueueEntries();
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("COMPLETED");
    expect((await store.listIntegrationQueueEntries({ status: "COMPLETED" })).length)
      .toBe(1);
    expect((await store.listIntegrationQueueEntries({ status: "PENDING" })).length)
      .toBe(0);
  });

  it("allows re-enqueueing a task/attempt pair once its active entry is settled", async () => {
    const first = await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1"),
    );
    const claimed = await store.claimNextIntegrationQueueEntry(
      "2026-01-01T00:01:00.000Z",
    );
    await store.completeIntegrationQueueEntry(
      claimed?.id ?? "",
      "2026-01-01T00:05:00.000Z",
    );

    const reQueued = await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1", { enqueuedAt: "2026-01-01T00:09:00.000Z" }),
    );

    expect(reQueued.status).toBe("PENDING");
    expect(reQueued.sequence).toBeGreaterThan(first.sequence);
    expect(await store.listIntegrationQueueEntries()).toHaveLength(2);
  });

  it("survives a store reopen with the durable queue state intact", async () => {
    const entry = await store.enqueueIntegrationQueueEntry(
      request("M001", "att_M001_1"),
    );
    await store.claimNextIntegrationQueueEntry("2026-01-01T00:01:00.000Z");
    await store.completeIntegrationQueueEntry(
      entry.id,
      "2026-01-01T00:05:00.000Z",
    );
    await store.enqueueIntegrationQueueEntry(request("M002", "att_M002_1"));
    await store.close();

    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      const entries = await reopened.listIntegrationQueueEntries();
      expect(entries.map((queued) => [queued.taskId, queued.status])).toEqual([
        ["M001", "COMPLETED"],
        ["M002", "PENDING"],
      ]);
      const nextClaim = await reopened.claimNextIntegrationQueueEntry(
        "2026-01-02T00:00:00.000Z",
      );
      expect(nextClaim?.taskId).toBe("M002");
    } finally {
      await reopened.close();
    }
  });

  it("keeps the queue sequence monotonic across reopen", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    await store.close();
    const reopened = createSqliteRunnerStore({ path: dbPath });
    try {
      await reopened.initialize();
      const second = await reopened.enqueueIntegrationQueueEntry(
        request("M002", "att_M002_1"),
      );
      expect(second.sequence).toBe(2);
    } finally {
      await reopened.close();
    }
  });

  it("filters queue listings by task, attempt, and status", async () => {
    await store.enqueueIntegrationQueueEntry(request("M001", "att_M001_1"));
    await store.enqueueIntegrationQueueEntry(request("M002", "att_M002_1"));

    expect(
      (await store.listIntegrationQueueEntries({ taskId: "M001" })).map(
        (entry) => entry.taskId,
      ),
    ).toEqual(["M001"]);
    expect(
      (await store.listIntegrationQueueEntries({ attemptId: "att_M002_1" })).map(
        (entry) => entry.attemptId,
      ),
    ).toEqual(["att_M002_1"]);
    expect(
      (await store.listIntegrationQueueEntries({ status: "PENDING" })).map(
        (entry) => entry.sequence,
      ),
    ).toEqual([1, 2]);
  });

  it("rejects enqueueing a request whose owning task or attempt does not exist", async () => {
    await expect(
      store.enqueueIntegrationQueueEntry(request("M999", "att_M001_1")),
    ).rejects.toThrow(/owning task or attempt does not exist/);
    await expect(
      store.enqueueIntegrationQueueEntry(request("M001", "att_M999_x")),
    ).rejects.toThrow(/owning task or attempt does not exist/);
    expect(await store.listIntegrationQueueEntries()).toEqual([]);
  });

  it("rejects invalid enqueue requests before touching the database", async () => {
    await expect(
      store.enqueueIntegrationQueueEntry(
        request("M001", "att_M001_1", { taskRevision: "" }),
      ),
    ).rejects.toThrow(/non-empty task revision/);
    await expect(
      store.enqueueIntegrationQueueEntry(
        request("M001", "att_M001_1", { branch: "" }),
      ),
    ).rejects.toThrow(/non-empty task branch/);
    await expect(
      store.enqueueIntegrationQueueEntry({
        ...request("M001", "att_M001_1"),
        enqueuedAt: "",
      }),
    ).rejects.toThrow(PersistenceError);
    expect(await store.listIntegrationQueueEntries()).toEqual([]);
  });

  it("performs no Git integration: queue operations run outside any repository", async () => {
    const plainDirectory = mkdtempSync(join(tmpdir(), "agentic-runner-m047a-nogit-"));
    try {
      const isolated = createSqliteRunnerStore({
        path: join(plainDirectory, "state.db"),
      });
      await isolated.initialize();
      await isolated.putProject(createProject());
      await isolated.putTask(createTask({ id: "M001" }));
      await isolated.putAttempt(createAttempt({ id: "att_M001_1", taskId: "M001" }));

      const entry = await isolated.enqueueIntegrationQueueEntry(
        request("M001", "att_M001_1"),
      );
      const claimed = await isolated.claimNextIntegrationQueueEntry(
        "2026-01-01T00:01:00.000Z",
      );
      await isolated.completeIntegrationQueueEntry(
        entry.id,
        "2026-01-01T00:05:00.000Z",
      );

      expect(claimed?.status).toBe("INTEGRATING");
      expect(
        (await isolated.listIntegrationQueueEntries()).map(
          (queued: IntegrationQueueEntry) => queued.status,
        ),
      ).toEqual(["COMPLETED"]);
      await isolated.close();
    } finally {
      rmSync(plainDirectory, { recursive: true, force: true });
    }
  });
});
