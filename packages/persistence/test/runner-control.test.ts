import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createSqliteRunnerStore, SCHEMA_MIGRATIONS } from "@agentic-dev-runner/persistence";
import { createAttempt, createProject, createTask } from "./fixtures.js";

it("upgrades v10 without losing data and defaults existing projects to running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-control-"));
  const path = join(dir, "state.db");
  const old = createSqliteRunnerStore({ path, migrations: SCHEMA_MIGRATIONS.slice(0, 10) });
  try {
    await old.initialize();
    await old.putProject(createProject());
    await old.putTask(createTask({ status: "READY", approvalGrantedAt: "2026-01-02T00:00:00.000Z" }));
    await old.putAttempt(createAttempt());
    await old.close();
    const store = createSqliteRunnerStore({ path });
    try {
      await store.initialize();
      expect(await store.getRunnerControl("proj-1")).toEqual({ projectId: "proj-1", state: "RUNNING" });
      expect((await store.getTask("M001"))?.approvalGrantedAt).toBe("2026-01-02T00:00:00.000Z");
      expect(await store.listAttempts()).toHaveLength(1);
      const db = new DatabaseSync(path);
      try { expect(Number(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version)).toBe(11); } finally { db.close(); }
    } finally { await store.close(); }
  } finally { await old.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("persists idempotent control per project and gates claims without side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-control-"));
  const path = join(dir, "state.db");
  let store = createSqliteRunnerStore({ path });
  const at = "2026-02-01T00:00:00.000Z";
  try {
    await store.initialize();
    await store.putProject(createProject());
    await store.putProject(createProject({ id: "other" }));
    await store.putTask(createTask({ status: "READY" }));
    await store.putTask(createTask({ id: "M002", projectId: "other", status: "READY" }));
    const paused = await store.pauseRunner("proj-1", at, "maintenance");
    expect(paused.changed).toBe(true);
    expect(await store.pauseRunner("proj-1", "2026-02-02T00:00:00.000Z", "ignored")).toEqual({ changed: false, control: paused.control });
    await store.close();
    store = createSqliteRunnerStore({ path });
    await store.initialize();
    expect(await store.getRunnerControl("proj-1")).toEqual(paused.control);
    expect((await store.getRunnerControl("other")).state).toBe("RUNNING");
    const request = { taskId: "M001", executionId: "exec-1", maxParallelism: 2, resources: ["resource"], claimedAt: at, leaseExpiresAt: "2026-02-01T00:01:00.000Z" };
    expect(await store.claimTaskExecution(request)).toEqual({ kind: "runner-paused", taskId: "M001" });
    expect(await store.listExecutionClaims()).toEqual([]);
    expect(await store.listResourceLocks()).toEqual([]);
    expect(await store.listAttempts()).toEqual([]);
    expect((await store.getTask("M001"))?.status).toBe("READY");
    expect((await store.claimTaskExecution({ ...request, taskId: "M002", executionId: "exec-2", resources: [] })).kind).toBe("claimed");
    const resumed = await store.resumeRunner("proj-1", at);
    expect(resumed.changed).toBe(true);
    expect(await store.resumeRunner("proj-1", "2026-02-02T00:00:00.000Z")).toEqual({ changed: false, control: resumed.control });
    await store.close();
    store = createSqliteRunnerStore({ path });
    await store.initialize();
    expect(await store.getRunnerControl("proj-1")).toEqual(resumed.control);
    expect((await store.claimTaskExecution(request)).kind).toBe("claimed");
    await expect(store.pauseRunner("proj-1", "")).rejects.toThrow();
    await expect(store.pauseRunner("proj-1", at, "")).rejects.toThrow();
    await expect(store.resumeRunner("proj-1", "")).rejects.toThrow();
    await expect(store.getRunnerControl("")).rejects.toThrow();
    await expect(store.getRunnerControl("missing")).rejects.toThrow();
    await expect(store.pauseRunner("missing", at)).rejects.toThrow();
    await expect(store.resumeRunner("missing", at)).rejects.toThrow();
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("joins caller-owned transactions and retains standalone control operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-control-"));
  const store = createSqliteRunnerStore({ path: join(dir, "state.db") });
  const at = "2026-02-01T00:00:00.000Z";
  try {
    await store.initialize();
    await store.putProject(createProject());
    await expect(store.transaction(async () => {
      await store.pauseRunner("proj-1", at);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect((await store.getRunnerControl("proj-1")).state).toBe("RUNNING");
    await store.transaction(async () => { await store.pauseRunner("proj-1", at); });
    expect((await store.getRunnerControl("proj-1")).state).toBe("PAUSED");
    await store.resumeRunner("proj-1", at);
    expect((await store.getRunnerControl("proj-1")).state).toBe("RUNNING");
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rejects an unexpected preexisting control table without advancing v10", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-control-"));
  const path = join(dir, "state.db");
  const old = createSqliteRunnerStore({ path, migrations: SCHEMA_MIGRATIONS.slice(0, 10) });
  try {
    await old.initialize();
    await old.putProject(createProject());
    await old.close();
    const db = new DatabaseSync(path);
    try { db.exec("CREATE TABLE runner_control (marker TEXT); INSERT INTO runner_control VALUES ('preserve')"); } finally { db.close(); }
    const upgraded = createSqliteRunnerStore({ path });
    try { await expect(upgraded.initialize()).rejects.toThrow('add-runner-control-state'); } finally { await upgraded.close(); }
    const check = new DatabaseSync(path);
    try {
      expect(Number(check.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version)).toBe(10);
      expect(check.prepare("SELECT marker FROM runner_control").get()?.marker).toBe("preserve");
    } finally { check.close(); }
  } finally { await old.close(); rmSync(dir, { recursive: true, force: true }); }
});
