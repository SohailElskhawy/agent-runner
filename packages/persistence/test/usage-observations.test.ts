import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
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

  it("preserves the execution mode across omission and rejects contradictory writes", async () => {
    await store.putAttempt({ ...createAttempt(), executionMode: "single-task" });
    await store.putAttempt({ ...createAttempt(), executionMode: "single-task" });
    await store.putAttempt({ ...createAttempt(), status: "FAILED" });
    await reopen();
    expect(await store.getAttempt("attempt-1")).toMatchObject({ status: "FAILED", executionMode: "single-task" });
    const before = rawRow("SELECT * FROM attempts");
    await expect(store.putAttempt({ ...createAttempt(), status: "RUNNING", executionMode: "workflow" })).rejects.toThrow(PersistenceError);
    expect(rawRow("SELECT * FROM attempts")).toEqual(before);
  });

  it("rolls back a caller-owned transaction on a mode conflict", async () => {
    await store.putAttempt({ ...createAttempt(), executionMode: "workflow", invocationUsage: COMPLETE });
    await expect(store.transaction(async () => {
      await store.putStageRun(createStageRun());
      await store.putAttempt({ ...createAttempt(), executionMode: "single-task", invocationUsage: COMPLETE });
    })).rejects.toThrow(/execution mode/);
    expect(await store.listStageRuns("attempt-1")).toEqual([]);
    expect(await store.getAttempt("attempt-1")).toMatchObject({ executionMode: "workflow", invocationUsage: COMPLETE });
  });

  it("rejects malformed input and stored execution modes without exposing them", async () => {
    const bad = "private-payload";
    const before = rawRow("SELECT * FROM attempts");
    await expect(store.putAttempt({ ...createAttempt(), status: "FAILED", executionMode: bad as "workflow" })).rejects.toThrow(/execution mode/);
    expect(rawRow("SELECT * FROM attempts")).toEqual(before);
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE attempts SET execution_mode = ?").run(bad); } finally { db.close(); }
    await expect(store.getAttempt("attempt-1")).rejects.toThrow(/execution mode/);
    try { await store.getAttempt("attempt-1"); } catch (error) { expect(String(error)).not.toContain(bad); }
    const corrupt = rawRow("SELECT * FROM attempts");
    await expect(store.putAttempt({ ...createAttempt(), status: "FAILED" })).rejects.toThrow(/execution mode/);
    expect(rawRow("SELECT * FROM attempts")).toEqual(corrupt);
  });

  it("rolls back a failed v13 migration", () => {
    const db = new DatabaseSync(join(directory, "rollback-v13.db"));
    try {
      migrateSchema(db, { migrations: SCHEMA_MIGRATIONS.slice(0, 12) });
      const failing: typeof SCHEMA_MIGRATIONS = [...SCHEMA_MIGRATIONS.slice(0, 12), {
        version: 13, name: "failed-mode", up: (target) => {
          target.exec("ALTER TABLE attempts ADD COLUMN execution_mode TEXT");
          target.exec("INVALID SQL");
        },
      }];
      expect(() => migrateSchema(db, { migrations: failing })).toThrow(PersistenceError);
      expect(db.prepare("PRAGMA table_info(attempts)").all().map((row) => row["name"])).not.toContain("execution_mode");
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"]).toBe(12);
      expect(migrateSchema(db)).toBe(13);
    } finally { db.close(); }
  });

  it("upgrades v12 without backfill and refuses explicit mode on v12", async () => {
    const path = join(directory, "v12.db");
    const old = createSqliteRunnerStore({ path, migrations: SCHEMA_MIGRATIONS.slice(0, 12) });
    await old.initialize();
    await old.putProject(createProject());
    insertTaskRow(path, createTask());
    await old.putAttempt(createAttempt());
    await expect(old.putAttempt({ ...createAttempt(), status: "FAILED", executionMode: "workflow" })).rejects.toThrow(/schema predates/);
    expect(await old.getAttempt("attempt-1")).toEqual(createAttempt());
    await old.close();
    const upgraded = createSqliteRunnerStore({ path });
    try {
      await upgraded.initialize();
      expect(await upgraded.getAttempt("attempt-1")).toEqual(createAttempt());
      await upgraded.putAttempt({ ...createAttempt(), executionMode: "workflow" });
      expect(await upgraded.getAttempt("attempt-1")).toMatchObject({ executionMode: "workflow" });
    } finally { await upgraded.close(); }
  });

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

  it("accepts evidence on a new attempt and stage row", async () => {
    const attempt = { ...createAttempt({ id: "attempt-2" }), number: 2, invocationUsage: COMPLETE };
    const stage = { ...createStageRun({ id: "stage-run-2", attemptId: "attempt-2" }), usage: COMPLETE };
    await store.putAttempt(attempt);
    await store.putStageRun(stage);
    expect(await store.getAttempt("attempt-2")).toEqual(attempt);
    expect(await store.listStageRuns("attempt-2")).toEqual([stage]);
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

  it("does not erase stored evidence when a later put omits it", async () => {
    await store.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });

    await store.putAttempt({ ...createAttempt(), status: "FAILED" });
    await store.putStageRun(createStageRun({ status: "FAILED" }));
    const attempt = await store.getAttempt("attempt-1");
    expect(attempt).toMatchObject({ status: "FAILED", invocationUsage: COMPLETE });
    const [run] = await store.listStageRuns("attempt-1");
    expect(run).toMatchObject({ status: "FAILED", usage: COMPLETE });

  });

  it.each([
    ["unknown", UNKNOWN],
    ["different counters", { ...COMPLETE, counters: { inputTokens: 101 } }],
    ["different provenance", { ...COMPLETE, cost: { ...COMPLETE.cost!, provenance: { source: "other", scope: "invocation" } } }],
  ])("rejects %s replacements without changing either row", async (_name, replacement) => {
    await store.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });
    const attemptBefore = rawRow("SELECT * FROM attempts");
    const stageBefore = rawRow("SELECT * FROM stage_runs");
    await expect(store.putAttempt({ ...createAttempt(), status: "FAILED", invocationUsage: replacement })).rejects.toThrow(PersistenceError);
    await expect(store.putStageRun({ ...createStageRun({ status: "FAILED", output: { stdout: "changed" } }), usage: replacement })).rejects.toThrow(PersistenceError);
    expect(rawRow("SELECT * FROM attempts")).toEqual(attemptBefore);
    expect(rawRow("SELECT * FROM stage_runs")).toEqual(stageBefore);
  });

  it("accepts reordered identical evidence across connections and rejects conflicts after reopen", async () => {
    await store.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
    await store.putStageRun({ ...createStageRun(), usage: COMPLETE });
    const second = createSqliteRunnerStore({ path: dbPath });
    try {
      await second.initialize();
      const replay: InvocationUsageObservation = {
        cost: { provenance: { scope: "invocation", source: "provider-report" }, currency: "usd-as-reported", amount: "0.0042" },
        cacheRelation: "subset",
        counters: { cacheReadTokens: 40, outputTokens: 0, inputTokens: 100 },
        status: "complete", schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
      };
      const attemptEvidence = rawRow("SELECT invocation_usage_json FROM attempts");
      const stageEvidence = rawRow("SELECT usage_json FROM stage_runs");
      await second.putAttempt({ ...createAttempt(), status: "FAILED", invocationUsage: replay });
      await second.putStageRun({ ...createStageRun({ status: "FAILED" }), usage: replay });
      expect(rawRow("SELECT invocation_usage_json FROM attempts")).toEqual(attemptEvidence);
      expect(rawRow("SELECT usage_json FROM stage_runs")).toEqual(stageEvidence);
      await reopen();
      await expect(store.putAttempt({ ...createAttempt(), invocationUsage: UNKNOWN })).rejects.toThrow(PersistenceError);
      await expect(store.putStageRun({ ...createStageRun(), usage: UNKNOWN })).rejects.toThrow(PersistenceError);
      expect(await store.getAttempt("attempt-1")).toMatchObject({ status: "FAILED", invocationUsage: COMPLETE });
      expect((await store.listStageRuns("attempt-1"))[0]).toMatchObject({ status: "FAILED", usage: COMPLETE });
    } finally {
      await second.close();
    }
  });

  it("rejects a competing execution mode after another connection commits", async () => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData);
      db.exec("BEGIN IMMEDIATE");
      db.exec("UPDATE attempts SET execution_mode = 'workflow'");
      parentPort.postMessage("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 100);
    `, { eval: true, workerData: dbPath });
    try {
      await once(worker, "message");
      await expect(store.putAttempt({ ...createAttempt(), status: "FAILED", executionMode: "single-task" })).rejects.toThrow(/execution mode/);
      expect(await store.getAttempt("attempt-1")).toMatchObject({ status: "SUCCEEDED", executionMode: "workflow" });
    } finally { await worker.terminate(); }
  });

  it("checks evidence after a competing connection commits", async () => {
    await store.putStageRun(createStageRun());
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.path);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE attempts SET invocation_usage_json = ?").run(workerData.usage);
      db.prepare("UPDATE stage_runs SET usage_json = ?").run(workerData.usage);
      parentPort.postMessage("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 100);
    `, { eval: true, workerData: { path: dbPath, usage: JSON.stringify(COMPLETE) } });
    try {
      await once(worker, "message");
      await expect(store.putAttempt({ ...createAttempt(), status: "FAILED", invocationUsage: UNKNOWN })).rejects.toThrow(PersistenceError);
      await expect(store.putStageRun({ ...createStageRun({ status: "FAILED" }), usage: UNKNOWN })).rejects.toThrow(PersistenceError);
      expect(await store.getAttempt("attempt-1")).toMatchObject({ status: "SUCCEEDED", invocationUsage: COMPLETE });
      expect((await store.listStageRuns("attempt-1"))[0]).toMatchObject({ status: "SUCCEEDED", usage: COMPLETE });
    } finally {
      await worker.terminate();
    }
  });

  it("rolls back caller-owned transactions on conflicting evidence", async () => {
    await store.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
    await expect(store.transaction(async () => {
      await store.putStageRun(createStageRun());
      await store.putAttempt({ ...createAttempt(), invocationUsage: UNKNOWN });
    })).rejects.toThrow(PersistenceError);
    expect(await store.listStageRuns("attempt-1")).toEqual([]);
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
      await upgraded.putAttempt({ ...createAttempt(), invocationUsage: COMPLETE });
      expect((await upgraded.getAttempt("attempt-1"))?.invocationUsage).toEqual(COMPLETE);
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
