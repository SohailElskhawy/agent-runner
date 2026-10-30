import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INVOCATION_USAGE_SCHEMA_VERSION,
  type InvocationUsageObservation,
} from "@agentic-dev-runner/core";
import {
  PersistenceError,
  SCHEMA_MIGRATIONS,
  createSqliteRunnerStore,
  migrateSchema,
  type RunnerStore,
} from "@agentic-dev-runner/persistence";
import {
  createAttempt,
  createProject,
  createStageRun,
  createTask,
  insertTaskRow,
} from "./fixtures.js";

const COMPLETE: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "complete",
  counters: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 40 },
  cacheRelation: "subset",
  cost: {
    amount: "0.0042",
    currency: "usd-as-reported",
    provenance: { source: "provider-report", scope: "invocation" },
  },
};
const UNKNOWN: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "unknown",
};

// Values the contract rejects; none may reach a row.
const REJECTED: readonly [string, unknown][] = [
  ["future schema version", { ...COMPLETE, schemaVersion: 2 }],
  ["string schema version", { ...COMPLETE, schemaVersion: "1" }],
  ["missing schema version", { status: "unknown" }],
  ["unknown status", { ...COMPLETE, status: "estimated" }],
  ["unknown top-level key", { ...COMPLETE, derived: true }],
  ["negative counter", { ...COMPLETE, counters: { inputTokens: -1 } }],
  ["unknown cost key", { ...COMPLETE, cost: { ...COMPLETE.cost, estimated: true } }],
  ["unknown with evidence", { ...UNKNOWN, counters: { inputTokens: 0 } }],
  ["non-object", "complete"],
];

describe("invocation usage persistence", () => {
  let directory: string;
  let dbPath: string;
  let store: RunnerStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-usage-"));
    dbPath = join(directory, "state.db");
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
    await store.putProject(createProject());
    insertTaskRow(dbPath, createTask());
    await store.putAttempt(createAttempt());
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function rawRow(sql: string): Record<string, unknown> | undefined {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare(sql).get();
    } finally {
      db.close();
    }
  }

  async function reopen(): Promise<void> {
    await store.close();
    store = createSqliteRunnerStore({ path: dbPath });
    await store.initialize();
  }

  it("round-trips stage and attempt observations across reopen, preserving legacy fields", async () => {
    const attempt = { ...createAttempt(), invocationUsage: COMPLETE };
    await store.putAttempt(attempt);
    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });
    await store.putStageRun({ ...createStageRun({ id: "stage-run-2" }), usage: UNKNOWN });
    await reopen();

    expect(await store.getAttempt("attempt-1")).toEqual(attempt);
    const runs = await store.listStageRuns("attempt-1");
    expect(runs.map((run) => run.usage)).toEqual([COMPLETE, UNKNOWN]);
    expect(runs[0]).toEqual({ ...createStageRun(), usage: COMPLETE });
  });

  it("keeps explicit zero and absent counters distinct", async () => {
    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });
    const [run] = await store.listStageRuns("attempt-1");
    expect(run?.usage?.counters).toEqual({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 40 });
    expect(run?.usage?.counters).not.toHaveProperty("reasoningTokens");
  });

  it("leaves rows without an observation without a usage key (never zero)", async () => {
    await store.putStageRun(createStageRun());
    expect(await store.getAttempt("attempt-1")).toEqual(createAttempt());
    const [run] = await store.listStageRuns("attempt-1");
    expect(run).toEqual(createStageRun());
    expect(run).not.toHaveProperty("usage");
    expect(rawRow("SELECT usage_json FROM stage_runs")?.["usage_json"]).toBeNull();
    expect(rawRow("SELECT invocation_usage_json FROM attempts")?.["invocation_usage_json"]).toBeNull();
  });

  it.each(REJECTED)("rejects a %s with an explicit error and no partial write", async (_name, bad) => {
    await expect(
      store.putStageRun({ ...createStageRun(), usage: bad as InvocationUsageObservation }),
    ).rejects.toThrow(PersistenceError);
    expect(rawRow("SELECT COUNT(*) AS n FROM stage_runs")?.["n"]).toBe(0);

    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });
    await store.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
    await expect(
      store.putStageRun({
        ...createStageRun({ status: "FAILED" }),
        usage: bad as InvocationUsageObservation,
      }),
    ).rejects.toThrow(/usage observation/);
    await expect(
      store.putAttempt({
        ...createAttempt(),
        status: "FAILED",
        invocationUsage: bad as InvocationUsageObservation,
      }),
    ).rejects.toThrow(/usage observation/);

    // Existing rows are untouched, including their stored evidence.
    const [run] = await store.listStageRuns("attempt-1");
    expect(run).toEqual({ ...createStageRun(), usage: COMPLETE });
    expect((await store.getAttempt("attempt-1"))?.status).toBe("SUCCEEDED");
    expect((await store.getAttempt("attempt-1"))?.invocationUsage).toEqual(COMPLETE);
  });

  it("does not erase stored evidence when a later put omits it, but accepts a valid replacement", async () => {
    await store.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });

    await store.putAttempt({ ...createAttempt(), status: "FAILED" });
    await store.putStageRun(createStageRun({ status: "FAILED" }));
    const attempt = await store.getAttempt("attempt-1");
    expect(attempt).toMatchObject({ status: "FAILED", invocationUsage: COMPLETE });
    const [run] = await store.listStageRuns("attempt-1");
    expect(run).toMatchObject({ status: "FAILED", usage: COMPLETE });

    await store.putStageRun({ ...createStageRun(), usage: UNKNOWN });
    expect((await store.listStageRuns("attempt-1"))[0]?.usage).toEqual(UNKNOWN);
  });

  it("writes no orphan row when the stage run fails its foreign key", async () => {
    await expect(
      store.putStageRun({ ...createStageRun({ attemptId: "missing" }), usage: COMPLETE }),
    ).rejects.toThrow(/does not exist/);
    expect(rawRow("SELECT COUNT(*) AS n FROM stage_runs")?.["n"]).toBe(0);
  });

  it("refuses to read stored future-version or malformed evidence and leaves it unmodified", async () => {
    await store.putStageRun(createStageRun());
    const future = JSON.stringify({ ...COMPLETE, schemaVersion: 2 });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE stage_runs SET usage_json = ?").run(future);
      db.prepare("UPDATE attempts SET invocation_usage_json = ?").run("{not json");
    } finally {
      db.close();
    }

    await expect(store.listStageRuns("attempt-1")).rejects.toThrow(/future|unsupported/i);
    await expect(store.getAttempt("attempt-1")).rejects.toThrow(PersistenceError);
    await expect(store.listAttempts()).rejects.toThrow(PersistenceError);
    expect(rawRow("SELECT usage_json FROM stage_runs")?.["usage_json"]).toBe(future);
    expect(rawRow("SELECT invocation_usage_json FROM attempts")?.["invocation_usage_json"]).toBe("{not json");
  });

  it("loads rows written before the usage migration unchanged and accepts new evidence afterwards", async () => {
    const legacyPath = join(directory, "legacy.db");
    const legacy = createSqliteRunnerStore({
      path: legacyPath,
      migrations: SCHEMA_MIGRATIONS.slice(0, 11),
    });
    await legacy.initialize();
    await legacy.putProject(createProject());
    insertTaskRow(legacyPath, createTask());
    await legacy.putAttempt(createAttempt());
    await legacy.putStageRun(createStageRun({ output: { stdout: "out" } }));
    await legacy.close();

    const upgraded = createSqliteRunnerStore({ path: legacyPath });
    try {
      await upgraded.initialize();
      expect(await upgraded.getAttempt("attempt-1")).toEqual(createAttempt());
      expect(await upgraded.listStageRuns("attempt-1")).toEqual([
        createStageRun({ output: { stdout: "out" } }),
      ]);
      await upgraded.putStageRun({
        ...createStageRun({ output: { stdout: "out" } }),
        usage: COMPLETE,
      });
      expect((await upgraded.listStageRuns("attempt-1"))[0]?.usage).toEqual(COMPLETE);
    } finally {
      await upgraded.close();
    }
  });

  it("keeps a store on a pre-usage migration list working and refuses an explicit observation", async () => {
    const oldPath = join(directory, "old.db");
    const old = createSqliteRunnerStore({
      path: oldPath,
      migrations: SCHEMA_MIGRATIONS.slice(0, 11),
    });
    try {
      await old.initialize();
      await old.putProject(createProject());
      insertTaskRow(oldPath, createTask());
      await old.putAttempt(createAttempt());
      await old.putStageRun(createStageRun());
      await expect(
        old.putStageRun({ ...createStageRun(), usage: COMPLETE }),
      ).rejects.toThrow(/predates invocation usage/);
      expect(await old.listStageRuns("attempt-1")).toEqual([createStageRun()]);
    } finally {
      await old.close();
    }
  });

  it("rolls the whole migration back when its second statement fails", () => {
    const path = join(directory, "partial.db");
    const db = new DatabaseSync(path);
    try {
      migrateSchema(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 11) });
      db.exec("ALTER TABLE attempts ADD COLUMN invocation_usage_json TEXT");
      expect(() => migrateSchema(db)).toThrow(PersistenceError);
      const columns = db.prepare("PRAGMA table_info(stage_runs)").all() as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain("usage_json");
      const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
      expect(version?.["v"]).toBe(11);
    } finally {
      db.close();
    }
  });
});
