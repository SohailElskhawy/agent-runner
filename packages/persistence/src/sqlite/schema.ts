export type SchemaMigrationDatabase = {
  readonly exec: (sql: string) => void;
};

export type SchemaMigration = {
  readonly version: number;
  readonly name: string;
  readonly up: (db: SchemaMigrationDatabase) => void;
};

const SCHEMA_V1_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`,

  `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  milestone TEXT NOT NULL,
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  risk TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  routing_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  workflow TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
) STRICT`,

  `CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  base_revision TEXT NOT NULL,
  context_manifest_json TEXT,
  logs_json TEXT,
  token_usage_json TEXT,
  cost REAL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  failure_json TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
) STRICT`,

  `CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  task_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
];

const SCHEMA_V2_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS stage_runs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  failure_json TEXT,
  FOREIGN KEY (attempt_id) REFERENCES attempts(id)
) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_stage_runs_attempt_id ON stage_runs(attempt_id)`,
];

export function applySchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V1_STATEMENTS) {
    db.exec(statement);
  }
}

export function applyStageRunsSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V2_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V3_STATEMENTS = [
  `ALTER TABLE stage_runs ADD COLUMN output_json TEXT`,
];

export function applyStageRunOutputSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V3_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V4_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS resource_locks (
  resource TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT,
  acquired_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_resource_locks_task_id ON resource_locks(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resource_locks_attempt_id ON resource_locks(attempt_id)`,
];

export function applyResourceLocksSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V4_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V5_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS integration_queue (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  task_revision TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  failure_json TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (attempt_id) REFERENCES attempts(id)
) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_integration_queue_task_id ON integration_queue(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_integration_queue_attempt_id ON integration_queue(attempt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_integration_queue_status ON integration_queue(status)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_queue_active_identity
  ON integration_queue(task_id, attempt_id)
  WHERE status IN ('PENDING', 'INTEGRATING')`,
];

export function applyIntegrationQueueSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V5_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V6_STATEMENTS = [
  `ALTER TABLE resource_locks ADD COLUMN execution_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_resource_locks_execution_id ON resource_locks(execution_id)`,
  `CREATE TABLE IF NOT EXISTS execution_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  finished_at TEXT,
  failure_json TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_execution_claims_task_id ON execution_claims(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_claims_status ON execution_claims(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_claims_active_task
  ON execution_claims(task_id)
  WHERE status = 'ACTIVE'`,
];

export function applyExecutionClaimsSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V6_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V7_STATEMENTS = [
  `ALTER TABLE integration_queue ADD COLUMN execution_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_integration_queue_execution_id ON integration_queue(execution_id)`,
];

export function applyIntegrationQueueExecutionSchema(
  db: SchemaMigrationDatabase,
): void {
  for (const statement of SCHEMA_V7_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V8_STATEMENTS = [
  `ALTER TABLE execution_claims ADD COLUMN renewed_at TEXT`,
  `ALTER TABLE execution_claims ADD COLUMN lease_expires_at TEXT`,
  `UPDATE execution_claims
   SET renewed_at = claimed_at, lease_expires_at = claimed_at
   WHERE renewed_at IS NULL OR lease_expires_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_execution_claims_lease
   ON execution_claims(status, lease_expires_at)`,
];

export function applyExecutionClaimLeaseSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V8_STATEMENTS) {
    db.exec(statement);
  }
}

const SCHEMA_V9_STATEMENTS = [
  `ALTER TABLE execution_claims ADD COLUMN recovery_owner_id TEXT`,
  `ALTER TABLE execution_claims ADD COLUMN recovery_expires_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_execution_claims_recovery
   ON execution_claims(status, lease_expires_at, recovery_expires_at)`,
];

export function applyExecutionRecoveryOwnershipSchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V9_STATEMENTS) db.exec(statement);
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "initial-schema",
    up: applySchema,
  },
  {
    version: 2,
    name: "add-stage-runs",
    up: applyStageRunsSchema,
  },
  {
    version: 3,
    name: "add-stage-run-output",
    up: applyStageRunOutputSchema,
  },
  {
    version: 4,
    name: "add-resource-locks",
    up: applyResourceLocksSchema,
  },
  {
    version: 5,
    name: "add-integration-queue",
    up: applyIntegrationQueueSchema,
  },
  {
    version: 6,
    name: "add-execution-claims",
    up: applyExecutionClaimsSchema,
  },
  {
    version: 7,
    name: "add-integration-queue-execution-identity",
    up: applyIntegrationQueueExecutionSchema,
  },
  {
    version: 8,
    name: "add-execution-claim-leases",
    up: applyExecutionClaimLeaseSchema,
  },
  {
    version: 9,
    name: "add-execution-recovery-ownership",
    up: applyExecutionRecoveryOwnershipSchema,
  },
];

export const SCHEMA_VERSION: number =
  SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]?.version ?? 0;
