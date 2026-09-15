import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ATTEMPT_STATUSES,
  STAGE_KINDS,
  STAGE_RUN_STATUSES,
  TASK_RISKS,
  TASK_TYPES,
  isTaskStatus,
  type Attempt,
  type AttemptFailure,
  type AttemptId,
  type AttemptLogs,
  type ContextManifest,
  type Project,
  type ProjectId,
  type StageRun,
  type StageRunFailure,
  type Task,
  type TaskId,
  type TaskPriority,
  type TaskStatus,
  type TokenUsage,
} from "@agentic-dev-runner/core";
import type { NewEvent, StoredEvent } from "../ports/event.js";
import {
  type AttemptFilter,
  type EventFilter,
  type RunnerStore,
  type TaskFilter,
} from "../ports/runner-store.js";
import { PersistenceError, StoreClosedError } from "./errors.js";
import { migrateSchema } from "./migrations.js";
import { SCHEMA_MIGRATIONS, type SchemaMigration } from "./schema.js";

export type SqliteRunnerStoreOptions = {
  path: string;
  busyTimeoutMs?: number | undefined;
  migrations?: readonly SchemaMigration[] | undefined;
};

export function createSqliteRunnerStore(
  options: SqliteRunnerStoreOptions,
): RunnerStore {
  return new SqliteRunnerStore(options);
}

export class SqliteRunnerStore implements RunnerStore {
  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private readonly migrations: readonly SchemaMigration[];
  private db: DatabaseSync | null = null;
  private initializing: Promise<void> | null = null;

  constructor(options: SqliteRunnerStoreOptions) {
    this.path = options.path;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  }

  initialize(): Promise<void> {
    this.initializing ??= this.open();
    return this.initializing;
  }

  private async open(): Promise<void> {
    let db: DatabaseSync | null = null;
    try {
      if (this.path !== ":memory:") {
        mkdirSync(dirname(this.path), { recursive: true });
      }
      db = new DatabaseSync(this.path, {
        enableForeignKeyConstraints: true,
      });
      db.exec(`PRAGMA journal_mode = WAL;`);
      db.exec(`PRAGMA busy_timeout = ${String(this.busyTimeoutMs)};`);
      migrateSchema(db, {
        migrations: this.migrations,
        source: this.path,
      });
      this.db = db;
    } catch (error) {
      if (db !== null && db.isOpen) {
        db.close();
      }
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError(
        `Failed to open SQLite database at "${this.path}"`,
        error,
      );
    }
  }

  private requireDb(operation: string): DatabaseSync {
    if (this.db === null) {
      throw new StoreClosedError(operation);
    }
    return this.db;
  }

  async getProject(id: ProjectId): Promise<Project | null> {
    const db = this.requireDb("getProject");
    const row = getRow(
      db.prepare("SELECT * FROM projects WHERE id = ?"),
      [id],
    );
    return row === undefined ? null : projectFromRow(row);
  }

  async listProjects(): Promise<Project[]> {
    const db = this.requireDb("listProjects");
    const rows = getRows(
      db.prepare("SELECT * FROM projects ORDER BY id"),
      [],
    );
    return rows.map(projectFromRow);
  }

  async putProject(project: Project): Promise<void> {
    const db = this.requireDb("putProject");
    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         root_path = excluded.root_path,
         updated_at = excluded.updated_at`,
    ).run(
      project.id,
      project.name,
      project.rootPath,
      project.createdAt,
      project.updatedAt,
    );
  }

  async getTask(id: TaskId): Promise<Task | null> {
    const db = this.requireDb("getTask");
    const row = getRow(db.prepare("SELECT * FROM tasks WHERE id = ?"), [id]);
    return row === undefined ? null : taskFromRow(row);
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    const db = this.requireDb("listTasks");
    if (filter?.projectId !== undefined) {
      const rows = getRows(
        db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id"),
        [filter.projectId],
      );
      return rows.map(taskFromRow);
    }
    const rows = getRows(db.prepare("SELECT * FROM tasks ORDER BY id"), []);
    return rows.map(taskFromRow);
  }

  async putTask(task: Task): Promise<void> {
    const db = this.requireDb("putTask");
    db.prepare(
      `INSERT INTO tasks (
         id, project_id, title, milestone, status, type, priority, risk,
         definition_json, routing_json, provenance_json, depends_on_json,
         workflow, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         title = excluded.title,
         milestone = excluded.milestone,
         status = excluded.status,
         type = excluded.type,
         priority = excluded.priority,
         risk = excluded.risk,
         definition_json = excluded.definition_json,
         routing_json = excluded.routing_json,
         provenance_json = excluded.provenance_json,
         depends_on_json = excluded.depends_on_json,
         workflow = excluded.workflow,
         updated_at = excluded.updated_at`,
    ).run(
      task.id,
      task.projectId,
      task.title,
      task.milestone,
      task.status,
      task.type,
      task.priority,
      task.risk,
      JSON.stringify(task.definition),
      JSON.stringify(task.routing),
      JSON.stringify(task.provenance),
      JSON.stringify(task.dependsOn),
      task.workflow,
      task.createdAt,
      task.updatedAt,
    );
  }

  async getAttempt(id: AttemptId): Promise<Attempt | null> {
    const db = this.requireDb("getAttempt");
    const row = getRow(db.prepare("SELECT * FROM attempts WHERE id = ?"), [
      id,
    ]);
    return row === undefined ? null : attemptFromRow(row);
  }

  async listAttempts(filter?: AttemptFilter): Promise<Attempt[]> {
    const db = this.requireDb("listAttempts");
    if (filter?.taskId !== undefined) {
      const rows = getRows(
        db.prepare(
          "SELECT * FROM attempts WHERE task_id = ? ORDER BY number, id",
        ),
        [filter.taskId],
      );
      return rows.map(attemptFromRow);
    }
    const rows = getRows(
      db.prepare("SELECT * FROM attempts ORDER BY task_id, number, id"),
      [],
    );
    return rows.map(attemptFromRow);
  }

  async putAttempt(attempt: Attempt): Promise<void> {
    const db = this.requireDb("putAttempt");
    db.prepare(
      `INSERT INTO attempts (
         id, task_id, number, status, agent, model, base_revision,
         context_manifest_json, logs_json, token_usage_json, cost,
         started_at, finished_at, failure_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_id = excluded.task_id,
         number = excluded.number,
         status = excluded.status,
         agent = excluded.agent,
         model = excluded.model,
         base_revision = excluded.base_revision,
         context_manifest_json = excluded.context_manifest_json,
         logs_json = excluded.logs_json,
         token_usage_json = excluded.token_usage_json,
         cost = excluded.cost,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         failure_json = excluded.failure_json`,
    ).run(
      attempt.id,
      attempt.taskId,
      attempt.number,
      attempt.status,
      attempt.agent,
      attempt.model ?? null,
      attempt.baseRevision,
      attempt.contextManifest === undefined
        ? null
        : JSON.stringify(attempt.contextManifest),
      attempt.logs === undefined ? null : JSON.stringify(attempt.logs),
      attempt.tokenUsage === undefined
        ? null
        : JSON.stringify(attempt.tokenUsage),
      attempt.cost ?? null,
      attempt.startedAt,
      attempt.finishedAt ?? null,
      attempt.failure === undefined ? null : JSON.stringify(attempt.failure),
    );
  }

  async putStageRun(stageRun: StageRun): Promise<void> {
    const db = this.requireDb("putStageRun");
    try {
      db.prepare(
        `INSERT INTO stage_runs (
           id, attempt_id, stage, status, started_at, finished_at, failure_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           attempt_id = excluded.attempt_id,
           stage = excluded.stage,
           status = excluded.status,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           failure_json = excluded.failure_json`,
      ).run(
        stageRun.id,
        stageRun.attemptId,
        stageRun.stage,
        stageRun.status,
        stageRun.startedAt ?? null,
        stageRun.finishedAt ?? null,
        stageRun.failure === undefined
          ? null
          : JSON.stringify(stageRun.failure),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new PersistenceError(
          `Cannot persist stage run "${stageRun.id}": attempt "${stageRun.attemptId}" does not exist`,
          error,
        );
      }
      throw error;
    }
  }

  async listStageRuns(attemptId: AttemptId): Promise<StageRun[]> {
    const db = this.requireDb("listStageRuns");
    const rows = getRows(
      db.prepare(
        "SELECT * FROM stage_runs WHERE attempt_id = ? ORDER BY started_at, id",
      ),
      [attemptId],
    );
    return rows.map(stageRunFromRow);
  }

  async getTaskStatus(id: TaskId): Promise<TaskStatus | null> {
    const db = this.requireDb("getTaskStatus");
    const row = getRow(
      db.prepare("SELECT status FROM tasks WHERE id = ?"),
      [id],
    );
    if (row === undefined) {
      return null;
    }
    const status = row["status"];
    if (typeof status !== "string" || !isTaskStatus(status)) {
      throw new PersistenceError(
        `Stored task status for task "${id}" is not a valid TaskStatus`,
      );
    }
    return status;
  }

  async setTaskStatus(
    id: TaskId,
    status: TaskStatus,
    updatedAt: string,
  ): Promise<void> {
    const db = this.requireDb("setTaskStatus");
    const result = db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    if (Number(result.changes) === 0) {
      throw new PersistenceError(`Cannot set status for unknown task "${id}"`);
    }
  }

  async appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]> {
    if (events.length === 0) {
      return [];
    }
    const db = this.requireDb("appendEvents");
    const statement = db.prepare(
      `INSERT INTO events (id, type, task_id, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const stored: StoredEvent[] = [];
    for (const event of events) {
      const id = `evt_${randomUUID()}`;
      const result = statement.run(
        id,
        event.type,
        event.taskId,
        JSON.stringify(event.payload),
        event.occurredAt,
      );
      stored.push({
        id,
        type: event.type,
        taskId: event.taskId,
        payload: event.payload,
        occurredAt: event.occurredAt,
        sequence: Number(result.lastInsertRowid),
      });
    }
    return stored;
  }

  async listEvents(filter?: EventFilter): Promise<StoredEvent[]> {
    const db = this.requireDb("listEvents");
    const conditions: string[] = [];
    const parameters: SqlValue[] = [];
    if (filter?.taskId !== undefined) {
      conditions.push("task_id = ?");
      parameters.push(filter.taskId);
    }
    if (filter?.type !== undefined) {
      conditions.push("type = ?");
      parameters.push(filter.type);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = getRows(
      db.prepare(`SELECT * FROM events${where} ORDER BY sequence`),
      parameters,
    );
    return rows.map(storedEventFromRow);
  }

  async transaction<T>(body: () => Promise<T>): Promise<T> {
    const db = this.requireDb("transaction");
    if (db.isTransaction) {
      throw new PersistenceError("Nested transactions are not supported");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await body();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.initializing = null;
    if (db !== null && db.isOpen) {
      db.close();
    }
  }
}

type SqlValue = string | number | bigint | null;

function getRow(
  statement: { get: (...parameters: SqlValue[]) => unknown },
  parameters: SqlValue[],
): Record<string, unknown> | undefined {
  return statement.get(...parameters) as Record<string, unknown> | undefined;
}

function getRows(
  statement: { all: (...parameters: SqlValue[]) => unknown },
  parameters: SqlValue[],
): Record<string, unknown>[] {
  return statement.all(...parameters) as Record<string, unknown>[];
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: textColumn(row, "id"),
    name: textColumn(row, "name"),
    rootPath: textColumn(row, "root_path"),
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at"),
  };
}

function taskFromRow(row: Record<string, unknown>): Task {
  return {
    id: textColumn(row, "id"),
    projectId: textColumn(row, "project_id"),
    title: textColumn(row, "title"),
    milestone: textColumn(row, "milestone"),
    status: parseTaskStatus(textColumn(row, "status")),
    type: parseEnumerated(textColumn(row, "type"), TASK_TYPES, "task type"),
    priority: parsePriority(textColumn(row, "priority")),
    risk: parseEnumerated(textColumn(row, "risk"), TASK_RISKS, "task risk"),
    definition: jsonColumn(row, "definition_json"),
    routing: jsonColumn(row, "routing_json"),
    provenance: jsonColumn(row, "provenance_json"),
    dependsOn: jsonColumn<string[]>(row, "depends_on_json"),
    workflow: textColumn(row, "workflow"),
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at"),
  };
}

function attemptFromRow(row: Record<string, unknown>): Attempt {
  const model = optionalTextColumn(row, "model");
  const contextManifest = optionalJsonColumn<ContextManifest>(
    row,
    "context_manifest_json",
  );
  const logs = optionalJsonColumn<AttemptLogs>(row, "logs_json");
  const tokenUsage = optionalJsonColumn<TokenUsage>(row, "token_usage_json");
  const cost = optionalNumberColumn(row, "cost");
  const finishedAt = optionalTextColumn(row, "finished_at");
  const failure = optionalJsonColumn<AttemptFailure>(row, "failure_json");

  return {
    id: textColumn(row, "id"),
    taskId: textColumn(row, "task_id"),
    number: numberColumn(row, "number"),
    status: parseEnumerated(
      textColumn(row, "status"),
      ATTEMPT_STATUSES,
      "attempt status",
    ),
    agent: textColumn(row, "agent"),
    ...(model === null ? {} : { model }),
    baseRevision: textColumn(row, "base_revision"),
    ...(contextManifest === null ? {} : { contextManifest }),
    ...(logs === null ? {} : { logs }),
    ...(tokenUsage === null ? {} : { tokenUsage }),
    ...(cost === null ? {} : { cost }),
    startedAt: textColumn(row, "started_at"),
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(failure === null ? {} : { failure }),
  };
}

function storedEventFromRow(row: Record<string, unknown>): StoredEvent {
  return {
    id: textColumn(row, "id"),
    type: textColumn(row, "type"),
    taskId: optionalTextColumn(row, "task_id"),
    payload: jsonColumn(row, "payload_json"),
    occurredAt: textColumn(row, "occurred_at"),
    sequence: numberColumn(row, "sequence"),
  };
}

function stageRunFromRow(row: Record<string, unknown>): StageRun {
  const startedAt = optionalTextColumn(row, "started_at");
  const finishedAt = optionalTextColumn(row, "finished_at");
  const failure = optionalJsonColumn<StageRunFailure>(row, "failure_json");

  return {
    id: textColumn(row, "id"),
    attemptId: textColumn(row, "attempt_id"),
    stage: parseEnumerated(textColumn(row, "stage"), STAGE_KINDS, "stage kind"),
    status: parseEnumerated(
      textColumn(row, "status"),
      STAGE_RUN_STATUSES,
      "stage run status",
    ),
    ...(startedAt === null ? {} : { startedAt }),
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(failure === null ? {} : { failure }),
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    /FOREIGN KEY constraint failed/i.test(error.message)
  );
}

function textColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new PersistenceError(
      `Column "${column}" is missing or is not a string`,
    );
  }
  return value;
}

function optionalTextColumn(
  row: Record<string, unknown>,
  column: string,
): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new PersistenceError(`Column "${column}" is not a string`);
  }
  return value;
}

function numberColumn(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new PersistenceError(
      `Column "${column}" is missing or is not a number`,
    );
  }
  return Number(value);
}

function optionalNumberColumn(
  row: Record<string, unknown>,
  column: string,
): number | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new PersistenceError(`Column "${column}" is not a number`);
  }
  return Number(value);
}

function jsonColumn<T = unknown>(
  row: Record<string, unknown>,
  column: string,
): T {
  const text = textColumn(row, column);
  return parseJsonColumn<T>(text, column);
}

function optionalJsonColumn<T = unknown>(
  row: Record<string, unknown>,
  column: string,
): T | null {
  const text = optionalTextColumn(row, column);
  if (text === null) {
    return null;
  }
  return parseJsonColumn<T>(text, column);
}

function parseJsonColumn<T>(text: string, column: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new PersistenceError(
      `Column "${column}" does not contain valid JSON`,
      error,
    );
  }
}

function parseTaskStatus(value: string): TaskStatus {
  if (!isTaskStatus(value)) {
    throw new PersistenceError(`Unknown task status "${value}"`);
  }
  return value;
}

function parseEnumerated<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new PersistenceError(`Unknown ${label} "${value}"`);
}

function parsePriority(value: string): TaskPriority {
  if (!/^P\d+$/.test(value)) {
    throw new PersistenceError(`Unknown task priority "${value}"`);
  }
  return value as TaskPriority;
}
