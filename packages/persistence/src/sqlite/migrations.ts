import type { DatabaseSync } from "node:sqlite";
import { PersistenceError, SchemaVersionTooNewError } from "./errors.js";
import { SCHEMA_MIGRATIONS, type SchemaMigration } from "./schema.js";

const SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`;

export type MigrateSchemaOptions = {
  readonly migrations?: readonly SchemaMigration[] | undefined;
  readonly now?: (() => string) | undefined;
  readonly source?: string | undefined;
};

export function migrateSchema(
  db: DatabaseSync,
  options: MigrateSchemaOptions = {},
): number {
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  assertSequentialMigrations(migrations);
  const supportedVersion =
    migrations[migrations.length - 1]?.version ?? 0;
  const clock = options.now ?? defaultClock;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_MIGRATIONS_TABLE);
    let version = readSchemaVersion(db);
    if (version > supportedVersion) {
      throw new SchemaVersionTooNewError(
        version,
        supportedVersion,
        options.source,
      );
    }
    for (const migration of migrations) {
      if (migration.version <= version) {
        continue;
      }
      applyMigration(db, migration, clock);
      version = migration.version;
    }
    db.exec("COMMIT");
    return version;
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error instanceof PersistenceError
      ? error
      : new PersistenceError("Schema migration failed", error);
  }
}

function applyMigration(
  db: DatabaseSync,
  migration: SchemaMigration,
  clock: () => string,
): void {
  try {
    migration.up(db);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(migration.version, migration.name, clock());
  } catch (error) {
    throw new PersistenceError(
      `Schema migration "${migration.name}" (version ${migration.version}) failed`,
      error,
    );
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { readonly version?: unknown } | undefined;
  const version = row?.version;
  if (typeof version === "bigint") {
    return Number(version);
  }
  return typeof version === "number" ? version : 0;
}

function assertSequentialMigrations(
  migrations: readonly SchemaMigration[],
): void {
  if (migrations.length === 0) {
    throw new PersistenceError("Schema migrations must not be empty");
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new PersistenceError("Schema migrations must not contain gaps");
    }
    if (migration.version !== index + 1) {
      throw new PersistenceError(
        `Schema migrations must be sequential from version 1: expected version ${String(index + 1)} at position ${String(index)}, found version ${String(migration.version)}`,
      );
    }
    if (migration.name.length === 0) {
      throw new PersistenceError(
        `Schema migration at version ${String(migration.version)} must have a non-empty name`,
      );
    }
  }
}

function defaultClock(): string {
  return new Date().toISOString();
}
