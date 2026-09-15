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

export function applySchema(db: SchemaMigrationDatabase): void {
  for (const statement of SCHEMA_V1_STATEMENTS) {
    db.exec(statement);
  }
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "initial-schema",
    up: applySchema,
  },
];

export const SCHEMA_VERSION: number =
  SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]?.version ?? 0;
