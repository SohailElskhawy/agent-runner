import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ATTEMPT_STATUSES,
  EXECUTION_CLAIM_STATUSES,
  INTEGRATION_QUEUE_STATUSES,
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
  type ExecutionClaim,
  type ExecutionClaimId,
  type ExecutionClaimStatus,
  type IntegrationQueueEntry,
  type IntegrationQueueRequest,
  type IsoTimestamp,
  type Project,
  type ProjectId,
  type ResourceLock,
  type StageRun,
  type StageRunFailure,
  type StageRunOutput,
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
  type ExecutionClaimFilter,
  type IntegrationQueueFilter,
  type ResourceLockFilter,
  type RunnerStore,
  type TaskExecutionClaimRequest,
  type TaskExecutionClaimResult,
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
      configureSqliteConnection(db, this.busyTimeoutMs);
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
         workflow, created_at, updated_at, approval_granted_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         updated_at = excluded.updated_at,
         approval_granted_at = excluded.approval_granted_at`,
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
      task.approvalGrantedAt ?? null,
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

  async listExecutionClaims(filter?: ExecutionClaimFilter): Promise<ExecutionClaim[]> {
    const db = this.requireDb("listExecutionClaims");
    const conditions: string[] = [];
    const parameters: SqlValue[] = [];
    if (filter?.taskId !== undefined) {
      conditions.push("task_id = ?");
      parameters.push(filter.taskId);
    }
    if (filter?.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(filter.status);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = getRows(
      db.prepare(`SELECT * FROM execution_claims${where} ORDER BY claimed_at, id`),
      parameters,
    );
    return rows.map(executionClaimFromRow);
  }

  async claimTaskExecution(
    request: TaskExecutionClaimRequest,
  ): Promise<TaskExecutionClaimResult> {
    validateTaskExecutionClaimRequest(request);
    const db = this.requireDb("claimTaskExecution");
    if (db.isTransaction) {
      throw new PersistenceError("Nested transactions are not supported");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const taskRow = getRow(
        db.prepare("SELECT status FROM tasks WHERE id = ?"),
        [request.taskId],
      );
      if (taskRow === undefined || taskRow["status"] !== "READY") {
        db.exec("COMMIT");
        return { kind: "task-not-ready", taskId: request.taskId };
      }
      const activeClaim = getRow(
        db.prepare(
          "SELECT id FROM execution_claims WHERE task_id = ? AND status = 'ACTIVE' LIMIT 1",
        ),
        [request.taskId],
      );
      if (activeClaim !== undefined) {
        db.exec("COMMIT");
        return { kind: "already-claimed", taskId: request.taskId };
      }
      const activeCount = getRow(
        db.prepare("SELECT COUNT(*) AS count FROM execution_claims WHERE status = 'ACTIVE'"),
        [],
      );
      if (Number(activeCount?.["count"] ?? 0) >= request.maxParallelism) {
        db.exec("COMMIT");
        return { kind: "capacity-exhausted", taskId: request.taskId };
      }

      const requested = requestedResourceLocks(
        request.resources.map((resource) => ({
          resource,
          taskId: request.taskId,
          executionId: request.executionId,
          acquiredAt: request.claimedAt,
        })),
      );
      for (const lock of requested) {
        const existing = getRow(
          db.prepare("SELECT * FROM resource_locks WHERE resource = ?"),
          [lock.resource],
        );
        if (
          existing !== undefined &&
          !sameExecutionLockOwner(resourceLockFromRow(existing), lock)
        ) {
          db.exec("COMMIT");
          return { kind: "resource-unavailable", taskId: request.taskId };
        }
      }

      db.prepare(
        `INSERT INTO execution_claims
         (id, task_id, status, claimed_at, renewed_at, lease_expires_at)
         VALUES (?, ?, 'ACTIVE', ?, ?, ?)`,
      ).run(request.executionId, request.taskId, request.claimedAt, request.claimedAt, request.leaseExpiresAt);
      const insertLock = db.prepare(
        `INSERT INTO resource_locks
         (resource, task_id, attempt_id, execution_id, acquired_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const lock of requested) {
        insertLock.run(
          lock.resource,
          lock.taskId,
          lock.attemptId ?? null,
          lock.executionId ?? null,
          lock.acquiredAt ?? null,
        );
      }
      db.exec("COMMIT");
      return {
        kind: "claimed",
        claim: {
          id: request.executionId,
          taskId: request.taskId,
          status: "ACTIVE",
          claimedAt: request.claimedAt,
          renewedAt: request.claimedAt,
          leaseExpiresAt: request.leaseExpiresAt,
        },
      };
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("Task execution claim failed", error);
    }
  }

  async renewTaskExecution(
    executionId: ExecutionClaimId,
    renewedAt: IsoTimestamp,
    leaseExpiresAt: IsoTimestamp,
  ): Promise<boolean> {
    const db = this.requireDb("renewTaskExecution");
    const result = db.prepare(
      `UPDATE execution_claims
       SET renewed_at = ?, lease_expires_at = ?
       WHERE id = ? AND status = 'ACTIVE' AND recovery_owner_id IS NULL`,
    ).run(renewedAt, leaseExpiresAt, executionId);
    return Number(result.changes) === 1;
  }

  async claimExpiredExecutionRecovery(
    executionId: ExecutionClaimId,
    recoveryOwnerId: string,
    now: IsoTimestamp,
    recoveryExpiresAt: IsoTimestamp,
  ): Promise<boolean> {
    const db = this.requireDb("claimExpiredExecutionRecovery");
    if (db.isTransaction) throw new PersistenceError("Nested transactions are not supported");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare(
        `UPDATE execution_claims
         SET recovery_owner_id = ?, recovery_expires_at = ?
         WHERE id = ? AND status = 'ACTIVE' AND lease_expires_at <= ?
           AND (recovery_expires_at IS NULL OR recovery_expires_at <= ?)`,
      ).run(recoveryOwnerId, recoveryExpiresAt, executionId, now, now);
      db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new PersistenceError("Execution recovery claim failed", error);
    }
  }

  async assertRecoveredExecutionOwner(
    executionId: ExecutionClaimId,
    recoveryOwnerId: string,
    now: IsoTimestamp,
  ): Promise<void> {
    const db = this.requireDb("assertRecoveredExecutionOwner");
    const row = getRow(db.prepare(
      `SELECT id FROM execution_claims
       WHERE id = ? AND status = 'ACTIVE' AND recovery_owner_id = ?
         AND recovery_expires_at > ?`,
    ), [executionId, recoveryOwnerId, now]);
    if (row === undefined) {
      throw new PersistenceError("Recovery ownership is no longer current");
    }
  }

  async releaseTaskExecution(
    executionId: ExecutionClaimId,
    status: Exclude<ExecutionClaimStatus, "ACTIVE">,
    finishedAt: IsoTimestamp,
    failure?: { readonly message: string } | undefined,
  ): Promise<boolean> {
    if (!EXECUTION_CLAIM_STATUSES.includes(status)) {
      throw new PersistenceError("Execution claim release requires a terminal status");
    }
    const db = this.requireDb("releaseTaskExecution");
    if (db.isTransaction) {
      throw new PersistenceError("Nested transactions are not supported");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          `UPDATE execution_claims
           SET status = ?, finished_at = ?, failure_json = ?
           WHERE id = ? AND status = 'ACTIVE'
             AND lease_expires_at > ?
             AND recovery_owner_id IS NULL`,
        )
        .run(
          status,
          finishedAt,
          failure === undefined ? null : JSON.stringify(failure),
          executionId,
          finishedAt,
        );
      if (Number(result.changes) === 1) {
        db.prepare("DELETE FROM resource_locks WHERE execution_id = ?").run(
          executionId,
        );
      }
      db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("Execution claim release failed", error);
    }
  }

  async releaseRecoveredTaskExecution(
    executionId: ExecutionClaimId,
    recoveryOwnerId: string,
    status: Exclude<ExecutionClaimStatus, "ACTIVE">,
    finishedAt: IsoTimestamp,
    failure?: { readonly message: string } | undefined,
  ): Promise<boolean> {
    const db = this.requireDb("releaseRecoveredTaskExecution");
    if (db.isTransaction) throw new PersistenceError("Nested transactions are not supported");
    db.exec("BEGIN IMMEDIATE");
    try {
      const settled = db.prepare(
        `UPDATE execution_claims
         SET status = ?, finished_at = ?, failure_json = ?
         WHERE id = ? AND status = 'ACTIVE' AND recovery_owner_id = ?
           AND recovery_expires_at > ?`,
      ).run(status, finishedAt, failure === undefined ? null : JSON.stringify(failure), executionId, recoveryOwnerId, finishedAt);
      if (Number(settled.changes) === 1) {
        db.prepare("DELETE FROM resource_locks WHERE execution_id = ?").run(executionId);
      }
      db.exec("COMMIT");
      return Number(settled.changes) === 1;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new PersistenceError("Recovered execution settlement failed", error);
    }
  }

  async putStageRun(stageRun: StageRun): Promise<void> {
    const db = this.requireDb("putStageRun");
    try {
      db.prepare(
        `INSERT INTO stage_runs (
           id, attempt_id, stage, status, started_at, finished_at, failure_json, output_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           attempt_id = excluded.attempt_id,
           stage = excluded.stage,
           status = excluded.status,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           failure_json = excluded.failure_json,
           output_json = excluded.output_json`,
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
        stageRun.output === undefined
          ? null
          : JSON.stringify(stageRun.output),
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

  async listResourceLocks(filter?: ResourceLockFilter): Promise<ResourceLock[]> {
    const db = this.requireDb("listResourceLocks");
    const conditions: string[] = [];
    const parameters: SqlValue[] = [];
    if (filter?.taskId !== undefined) {
      conditions.push("task_id = ?");
      parameters.push(filter.taskId);
    }
    if (filter?.attemptId !== undefined) {
      conditions.push("attempt_id = ?");
      parameters.push(filter.attemptId);
    }
    if (filter?.executionId !== undefined) {
      conditions.push("execution_id = ?");
      parameters.push(filter.executionId);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = getRows(
      db.prepare(`SELECT * FROM resource_locks${where} ORDER BY resource`),
      parameters,
    );
    return rows.map(resourceLockFromRow);
  }

  async acquireResourceLocks(locks: readonly ResourceLock[]): Promise<void> {
    if (locks.length === 0) {
      return;
    }
    const db = this.requireDb("acquireResourceLocks");
    if (db.isTransaction) {
      throw new PersistenceError("Nested transactions are not supported");
    }
    const requested = requestedResourceLocks(locks);
    db.exec("BEGIN IMMEDIATE");
    try {
      const selectLock = db.prepare(
        "SELECT * FROM resource_locks WHERE resource = ?",
      );
      const insertLock = db.prepare(
        `INSERT INTO resource_locks (resource, task_id, attempt_id, acquired_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const lock of requested) {
        const existing = getRow(selectLock, [lock.resource]);
        if (existing === undefined) {
          try {
            insertLock.run(
              lock.resource,
              lock.taskId,
              lock.attemptId ?? null,
              lock.acquiredAt ?? null,
            );
          } catch (error) {
            throw missingLockOwnerError(lock, error);
          }
          continue;
        }
        const held = resourceLockFromRow(existing);
        if (
          held.taskId !== lock.taskId ||
          held.attemptId !== lock.attemptId
        ) {
          throw new PersistenceError(
            `Resource "${lock.resource}" is already held by task "${held.taskId}"` +
              (held.attemptId === undefined
                ? ""
                : ` (attempt "${held.attemptId}")`),
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("Resource lock acquisition failed", error);
    }
  }

  async releaseResourceLocks(filter: ResourceLockFilter): Promise<void> {
    if (filter.taskId === undefined && filter.attemptId === undefined) {
      throw new PersistenceError(
        "Releasing resource locks requires an explicit task or attempt filter",
      );
    }
    const db = this.requireDb("releaseResourceLocks");
    const conditions: string[] = [];
    const parameters: SqlValue[] = [];
    if (filter.taskId !== undefined) {
      conditions.push("task_id = ?");
      parameters.push(filter.taskId);
    }
    if (filter.attemptId !== undefined) {
      conditions.push("attempt_id = ?");
      parameters.push(filter.attemptId);
    }
    if (filter.executionId !== undefined) {
      conditions.push("execution_id = ?");
      parameters.push(filter.executionId);
    }
    db.prepare(`DELETE FROM resource_locks WHERE ${conditions.join(" AND ")}`)
      .run(...parameters);
  }

  async listIntegrationQueueEntries(
    filter?: IntegrationQueueFilter,
  ): Promise<IntegrationQueueEntry[]> {
    const db = this.requireDb("listIntegrationQueueEntries");
    const conditions: string[] = [];
    const parameters: SqlValue[] = [];
    if (filter?.taskId !== undefined) {
      conditions.push("task_id = ?");
      parameters.push(filter.taskId);
    }
    if (filter?.attemptId !== undefined) {
      conditions.push("attempt_id = ?");
      parameters.push(filter.attemptId);
    }
    if (filter?.executionId !== undefined) {
      conditions.push("execution_id = ?");
      parameters.push(filter.executionId);
    }
    if (filter?.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(filter.status);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = getRows(
      db.prepare(
        `SELECT * FROM integration_queue${where} ORDER BY sequence, id`,
      ),
      parameters,
    );
    return rows.map(integrationQueueEntryFromRow);
  }

  async enqueueIntegrationQueueEntry(
    request: IntegrationQueueRequest,
  ): Promise<IntegrationQueueEntry> {
    const db = this.requireDb("enqueueIntegrationQueueEntry");
    const id = request.id ?? `iq_${randomUUID()}`;
    if (typeof id !== "string" || id.length === 0) {
      throw new PersistenceError(
        "Integration queue entry identity must be a non-empty string",
      );
    }
    validateIntegrationQueueRequest(request);
    try {
      const result = db
        .prepare(
          `INSERT INTO integration_queue (
             id, task_id, attempt_id, execution_id, task_revision, branch,
             base_revision, status, enqueued_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(
          id,
          request.taskId,
          request.attemptId,
          request.executionId ?? null,
          request.taskRevision,
          request.branch,
          request.baseRevision,
          request.enqueuedAt,
        );
      return {
        id,
        sequence: Number(result.lastInsertRowid),
        taskId: request.taskId,
        attemptId: request.attemptId,
        ...(request.executionId === undefined
          ? {}
          : { executionId: request.executionId }),
        taskRevision: request.taskRevision,
        branch: request.branch,
        baseRevision: request.baseRevision,
        status: "PENDING",
        enqueuedAt: request.enqueuedAt,
      };
    } catch (error) {
      throw enqueueIntegrationQueueError(request, error);
    }
  }

  async claimNextIntegrationQueueEntry(
    claimedAt: IsoTimestamp,
  ): Promise<IntegrationQueueEntry | null> {
    const db = this.requireDb("claimNextIntegrationQueueEntry");
    if (db.isTransaction) {
      throw new PersistenceError("Nested transactions are not supported");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = getRow(
        db.prepare(
          "SELECT * FROM integration_queue WHERE status = 'INTEGRATING' LIMIT 1",
        ),
        [],
      );
      if (active !== undefined) {
        db.exec("COMMIT");
        return null;
      }
      const next = getRow(
        db.prepare(
          `SELECT * FROM integration_queue
           WHERE status = 'PENDING'
           ORDER BY sequence, id
           LIMIT 1`,
        ),
        [],
      );
      if (next === undefined) {
        db.exec("COMMIT");
        return null;
      }
      const entry = integrationQueueEntryFromRow(next);
      const updated = db
        .prepare(
          `UPDATE integration_queue
           SET status = 'INTEGRATING', claimed_at = ?
           WHERE sequence = ? AND status = 'PENDING'`,
        )
        .run(claimedAt, entry.sequence);
      if (Number(updated.changes) === 0) {
        throw new PersistenceError(
          `Integration queue entry "${entry.id}" was claimed concurrently; the claim is aborted`,
        );
      }
      db.exec("COMMIT");
      return { ...entry, status: "INTEGRATING", claimedAt };
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError("Integration queue claim failed", error);
    }
  }

  async completeIntegrationQueueEntry(
    id: string,
    finishedAt: IsoTimestamp,
  ): Promise<void> {
    const db = this.requireDb("completeIntegrationQueueEntry");
    const result = db
      .prepare(
        `UPDATE integration_queue
         SET status = 'COMPLETED', finished_at = ?, failure_json = NULL
         WHERE id = ? AND status = 'INTEGRATING'`,
      )
      .run(finishedAt, id);
    if (Number(result.changes) === 0) {
      throw new PersistenceError(
        `Cannot complete integration queue entry "${id}": it is not actively integrating`,
      );
    }
  }

  async failIntegrationQueueEntry(
    id: string,
    failure: { readonly message: string },
    finishedAt: IsoTimestamp,
  ): Promise<void> {
    const db = this.requireDb("failIntegrationQueueEntry");
    if (typeof failure.message !== "string" || failure.message.length === 0) {
      throw new PersistenceError(
        `Failed integration queue entry "${id}" requires a non-empty failure message`,
      );
    }
    const result = db
      .prepare(
        `UPDATE integration_queue
         SET status = 'FAILED', finished_at = ?, failure_json = ?
         WHERE id = ? AND status = 'INTEGRATING'`,
      )
      .run(finishedAt, JSON.stringify(failure), id);
    if (Number(result.changes) === 0) {
      throw new PersistenceError(
        `Cannot fail integration queue entry "${id}": it is not actively integrating`,
      );
    }
  }

  async requeueIntegrationQueueEntry(id: string): Promise<void> {
    const db = this.requireDb("requeueIntegrationQueueEntry");
    const result = db.prepare(
      `UPDATE integration_queue
       SET status = 'PENDING', claimed_at = NULL
       WHERE id = ? AND status = 'INTEGRATING'`,
    ).run(id);
    if (Number(result.changes) === 0) {
      throw new PersistenceError(
        `Cannot requeue integration queue entry "${id}": it is not actively integrating`,
      );
    }
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

  async transitionTaskStatusFrom(
    id: TaskId,
    from: TaskStatus,
    to: TaskStatus,
    updatedAt: IsoTimestamp,
  ): Promise<boolean> {
    const db = this.requireDb("transitionTaskStatusFrom");
    const result = db
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
      )
      .run(to, updatedAt, id, from);
    return Number(result.changes) === 1;
  }

  async approveTask(id: TaskId, grantedAt: IsoTimestamp): Promise<boolean> {
    const db = this.requireDb("approveTask");
    const result = db
      .prepare(
        "UPDATE tasks SET approval_granted_at = ?, updated_at = ? WHERE id = ? AND approval_granted_at IS NULL",
      )
      .run(grantedAt, grantedAt, id);
    return Number(result.changes) === 1;
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

/**
 * Configure contention handling before WAL initialization. SQLite may need
 * the busy handler while changing the journal mode, so this ordering is a
 * startup-safety invariant rather than a performance preference.
 */
export function configureSqliteConnection(
  db: { readonly exec: (sql: string) => void },
  busyTimeoutMs: number,
): void {
  db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
  db.exec(`PRAGMA journal_mode = WAL;`);
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
  const approvalGrantedAt = optionalTextColumn(row, "approval_granted_at");
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
    ...(approvalGrantedAt === null ? {} : { approvalGrantedAt }),
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

/**
 * Normalizes an acquisition request into unique, ascending-ordered locks.
 * Duplicate resources must carry identical ownership and collapse into one
 * lock; conflicting duplicates are rejected deterministically before any
 * database access.
 */
function requestedResourceLocks(
  locks: readonly ResourceLock[],
): readonly ResourceLock[] {
  const requested = new Map<string, ResourceLock>();
  for (const lock of locks) {
    if (typeof lock.resource !== "string" || lock.resource.length === 0) {
      throw new PersistenceError(
        "Every acquired resource lock must have a non-empty resource",
      );
    }
    if (typeof lock.taskId !== "string" || lock.taskId.length === 0) {
      throw new PersistenceError(
        `Resource lock "${lock.resource}" must have a non-empty owning task`,
      );
    }
    const existing = requested.get(lock.resource);
    if (existing === undefined) {
      requested.set(lock.resource, lock);
      continue;
    }
    if (
      existing.taskId !== lock.taskId ||
      existing.attemptId !== lock.attemptId ||
      existing.executionId !== lock.executionId
    ) {
      throw new PersistenceError(
        `Duplicate acquisition request for resource "${lock.resource}" carries conflicting ownership`,
      );
    }
  }
  return [...requested.values()].sort((left, right) =>
    left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : 0,
  );
}

function missingLockOwnerError(
  lock: ResourceLock,
  error: unknown,
): PersistenceError {
  if (isForeignKeyViolation(error)) {
    return new PersistenceError(
      `Cannot acquire resource "${lock.resource}": owning task "${lock.taskId}" does not exist`,
      error,
    );
  }
  return new PersistenceError(
    `Failed to acquire resource lock "${lock.resource}"`,
    error,
  );
}

function resourceLockFromRow(row: Record<string, unknown>): ResourceLock {
  const attemptId = optionalTextColumn(row, "attempt_id");
  const executionId = optionalTextColumn(row, "execution_id");
  const acquiredAt = optionalTextColumn(row, "acquired_at");
  return {
    resource: textColumn(row, "resource"),
    taskId: textColumn(row, "task_id"),
    ...(attemptId === null ? {} : { attemptId }),
    ...(executionId === null ? {} : { executionId }),
    ...(acquiredAt === null ? {} : { acquiredAt }),
  };
}

function sameExecutionLockOwner(
  left: ResourceLock,
  right: ResourceLock,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId &&
    left.executionId === right.executionId
  );
}

function executionClaimFromRow(row: Record<string, unknown>): ExecutionClaim {
  const finishedAt = optionalTextColumn(row, "finished_at");
  const failure = optionalJsonColumn<{ readonly message: string }>(
    row,
    "failure_json",
  );
  return {
    id: textColumn(row, "id"),
    taskId: textColumn(row, "task_id"),
    status: parseEnumerated(
      textColumn(row, "status"),
      EXECUTION_CLAIM_STATUSES,
      "execution claim status",
    ),
    claimedAt: textColumn(row, "claimed_at"),
    renewedAt: optionalTextColumn(row, "renewed_at") ?? textColumn(row, "claimed_at"),
    leaseExpiresAt: optionalTextColumn(row, "lease_expires_at") ?? textColumn(row, "claimed_at"),
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(failure === null ? {} : { failure }),
  };
}

function integrationQueueEntryFromRow(
  row: Record<string, unknown>,
): IntegrationQueueEntry {
  const claimedAt = optionalTextColumn(row, "claimed_at");
  const finishedAt = optionalTextColumn(row, "finished_at");
  const failure = optionalJsonColumn<{ readonly message: string }>(
    row,
    "failure_json",
  );
  const executionId = optionalTextColumn(row, "execution_id");
  return {
    id: textColumn(row, "id"),
    sequence: numberColumn(row, "sequence"),
    taskId: textColumn(row, "task_id"),
    attemptId: textColumn(row, "attempt_id"),
    ...(executionId === null ? {} : { executionId }),
    taskRevision: textColumn(row, "task_revision"),
    branch: textColumn(row, "branch"),
    baseRevision: textColumn(row, "base_revision"),
    status: parseEnumerated(
      textColumn(row, "status"),
      INTEGRATION_QUEUE_STATUSES,
      "integration queue status",
    ),
    enqueuedAt: textColumn(row, "enqueued_at"),
    ...(claimedAt === null ? {} : { claimedAt }),
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(failure === null ? {} : { failure }),
  };
}

/**
 * Validates an enqueue request before any database access so an invalid
 * request fails deterministically instead of surfacing as a constraint
 * violation.
 */
function validateIntegrationQueueRequest(
  request: IntegrationQueueRequest,
): void {
  requireNonEmptyText(request.taskId, "owning task id");
  requireNonEmptyText(request.attemptId, "owning attempt id");
  if (request.executionId !== undefined) {
    requireNonEmptyText(request.executionId, "execution claim id");
  }
  requireNonEmptyText(request.taskRevision, "task revision");
  requireNonEmptyText(request.branch, "task branch");
  requireNonEmptyText(request.baseRevision, "base revision");
  requireNonEmptyText(request.enqueuedAt, "enqueue timestamp");
}

function validateTaskExecutionClaimRequest(
  request: TaskExecutionClaimRequest,
): void {
  requireNonEmptyText(request.taskId, "task id");
  requireNonEmptyText(request.executionId, "execution claim id");
  requireNonEmptyText(request.claimedAt, "claim timestamp");
  requireNonEmptyText(request.leaseExpiresAt, "execution claim lease expiry");
  if (
    !Number.isInteger(request.maxParallelism) ||
    request.maxParallelism <= 0
  ) {
    throw new PersistenceError(
      "Execution claim maxParallelism must be a positive integer",
    );
  }
}

function requireNonEmptyText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new PersistenceError(
      `Integration queue entry requires a non-empty ${label}`,
    );
  }
}

/**
 * Maps enqueue failures onto deterministic persistence errors: a missing
 * owning task/attempt and an active duplicate of the same (task, attempt)
 * pair are named explicitly, everything else is wrapped.
 */
function enqueueIntegrationQueueError(
  request: IntegrationQueueRequest,
  error: unknown,
): PersistenceError {
  if (isForeignKeyViolation(error)) {
    return new PersistenceError(
      `Cannot enqueue integration queue entry for task "${request.taskId}"` +
        ` (attempt "${request.attemptId}"): the owning task or attempt does not exist`,
      error,
    );
  }
  if (isActiveIdentityViolation(error)) {
    return new PersistenceError(
      `An active integration queue entry for task "${request.taskId}"` +
        ` (attempt "${request.attemptId}") already exists`,
      error,
    );
  }
  if (isDuplicateIdViolation(error)) {
    return new PersistenceError(
      `Integration queue entry identity is already in use`,
      error,
    );
  }
  return new PersistenceError(
    `Failed to enqueue integration queue entry for task "${request.taskId}"`,
    error,
  );
}

function isActiveIdentityViolation(error: unknown): boolean {
  return /UNIQUE constraint failed: integration_queue\.task_id, integration_queue\.attempt_id/i.test(
    sqliteErrorMessage(error) ?? "",
  );
}

function isDuplicateIdViolation(error: unknown): boolean {
  return /UNIQUE constraint failed: integration_queue\.id/i.test(
    sqliteErrorMessage(error) ?? "",
  );
}

function sqliteErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function stageRunFromRow(row: Record<string, unknown>): StageRun {  const startedAt = optionalTextColumn(row, "started_at");
  const finishedAt = optionalTextColumn(row, "finished_at");
  const failure = optionalJsonColumn<StageRunFailure>(row, "failure_json");
  const output = optionalJsonColumn<StageRunOutput>(row, "output_json");

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
    ...(output === null ? {} : { output }),
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
