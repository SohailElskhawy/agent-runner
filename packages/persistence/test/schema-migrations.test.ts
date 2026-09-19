import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PersistenceError,
  SCHEMA_MIGRATIONS,
  SchemaVersionTooNewError,
  createSqliteRunnerStore,
  migrateSchema,
  type SchemaMigration,
} from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createAttempt, createProject, createTask } from "./fixtures.js";

function initialSchemaMigration(): SchemaMigration {
  const migration = SCHEMA_MIGRATIONS[0];
  if (migration === undefined) {
    throw new Error("initial schema migration is missing");
  }
  return migration;
}

const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

type MigrationRow = {
  version: number;
  name: string;
  appliedAt: string;
};

function probeChain(): readonly SchemaMigration[] {
  return [
    initialSchemaMigration(),
    {
      version: 2,
      name: "test-only-create-migration-probe",
      up: (db) => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS migration_probe (marker TEXT NOT NULL) STRICT",
        );
      },
    },
    {
      version: 3,
      name: "test-only-seed-migration-probe",
      up: (db) => {
        db.exec(
          "INSERT INTO migration_probe (marker) VALUES ('v3-applied')",
        );
      },
    },
    {
      version: 4,
      name: "test-only-far-future-migration-probe",
      up: (db) => {
        db.exec(
          "INSERT INTO migration_probe (marker) VALUES ('v4-applied')",
        );
      },
    },
    {
      version: 5,
      name: "test-only-beyond-supported-migration-probe",
      up: (db) => {
        db.exec(
          "INSERT INTO migration_probe (marker) VALUES ('v5-applied')",
        );
      },
    },
    {
      version: 6,
      name: "test-only-beyond-supported-migration-probe-2",
      up: (db) => {
        db.exec(
          "INSERT INTO migration_probe (marker) VALUES ('v6-applied')",
        );
      },
    },
  ];
}

function failingProbeChain(): readonly SchemaMigration[] {
  return [
    ...probeChain(),
    {
      version: 7,
      name: "test-only-invalid-sql",
      up: (db) => {
        db.exec("CREATE TABLE definitely_broken (");
      },
    },
  ];
}

function futureSchemaChain(): readonly SchemaMigration[] {
  return [
    ...SCHEMA_MIGRATIONS,
    { version: 8, name: "test-only-future-schema", up: () => undefined },
  ];
}

function readMigrationRows(dbPath: string): MigrationRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
      )
      .all() as ReadonlyArray<{
      readonly version?: unknown;
      readonly name?: unknown;
      readonly applied_at?: unknown;
    }>;
    return rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      appliedAt: String(row.applied_at),
    }));
  } finally {
    db.close();
  }
}

function readProbeMarkers(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare("SELECT marker FROM migration_probe ORDER BY rowid")
      .all() as ReadonlyArray<{ readonly marker?: unknown }>;
    return rows.map((row) => String(row.marker));
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, tableName: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(tableName) as { readonly name?: unknown } | undefined;
    return row !== undefined;
  } finally {
    db.close();
  }
}

async function withStore<T>(
  store: RunnerStore,
  body: (opened: RunnerStore) => Promise<T>,
): Promise<T> {
  try {
    return await body(store);
  } finally {
    await store.close();
  }
}

describe("SQLite schema migrations", () => {
  let directory: string;
  let dbPath: string;
  let store: RunnerStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m008-"));
    dbPath = join(directory, "state.db");
    store = createSqliteRunnerStore({ path: dbPath });
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("initializes a fresh database at the latest schema version", async () => {
    await store.initialize();
    await store.putProject(createProject());
    await store.close();

    expect(readMigrationRows(dbPath)).toEqual([
      { version: 1, name: "initial-schema", appliedAt: expect.any(String) },
      { version: 2, name: "add-stage-runs", appliedAt: expect.any(String) },
      {
        version: 3,
        name: "add-stage-run-output",
        appliedAt: expect.any(String),
      },
      {
        version: 4,
        name: "add-resource-locks",
        appliedAt: expect.any(String),
      },
      {
        version: 5,
        name: "add-integration-queue",
        appliedAt: expect.any(String),
      },
      {
        version: 6,
        name: "add-execution-claims",
        appliedAt: expect.any(String),
      },
      {
        version: 7,
        name: "add-integration-queue-execution-identity",
        appliedAt: expect.any(String),
      },
    ]);
  });

  it("upgrades an existing v1 database to the latest version with existing data intact", async () => {
    const legacyProject = createProject({ name: "legacy-project" });
    const legacyTask = createTask();
    const legacyAttempt = createAttempt();
    const v1Store = createSqliteRunnerStore({
      path: dbPath,
      migrations: [initialSchemaMigration()],
    });
    try {
      await v1Store.initialize();
      await v1Store.putProject(legacyProject);
      await v1Store.putTask(legacyTask);
      await v1Store.putAttempt(legacyAttempt);
      await v1Store.appendEvents([
        {
          type: "task.created",
          taskId: legacyTask.id,
          payload: { title: legacyTask.title },
          occurredAt: "2026-01-01T00:00:01.000Z",
        },
      ]);
    } finally {
      await v1Store.close();
    }
    expect(readMigrationRows(dbPath)).toEqual([
      { version: 1, name: "initial-schema", appliedAt: expect.any(String) },
    ]);

    const upgraded = createSqliteRunnerStore({ path: dbPath });
    await withStore(upgraded, async (opened) => {
      await opened.initialize();

      expect(readMigrationRows(dbPath)).toEqual([
        { version: 1, name: "initial-schema", appliedAt: expect.any(String) },
        { version: 2, name: "add-stage-runs", appliedAt: expect.any(String) },
        {
          version: 3,
          name: "add-stage-run-output",
          appliedAt: expect.any(String),
        },
        {
          version: 4,
          name: "add-resource-locks",
          appliedAt: expect.any(String),
        },
        {
          version: 5,
          name: "add-integration-queue",
          appliedAt: expect.any(String),
        },
        {
          version: 6,
          name: "add-execution-claims",
          appliedAt: expect.any(String),
        },
        {
          version: 7,
          name: "add-integration-queue-execution-identity",
          appliedAt: expect.any(String),
        },
      ]);
      expect(await opened.getProject(legacyProject.id)).toEqual(legacyProject);
      expect(await opened.getTask(legacyTask.id)).toEqual(legacyTask);
      expect(await opened.getAttempt(legacyAttempt.id)).toEqual(legacyAttempt);
      expect(await opened.listEvents()).toHaveLength(1);
    });
  });

  it("performs no migration when reopening an already migrated database", async () => {
    await store.initialize();
    await store.close();
    const before = readMigrationRows(dbPath);

    const reopened = createSqliteRunnerStore({ path: dbPath });
    await withStore(reopened, async (opened) => {
      await opened.initialize();
      await opened.initialize();
      expect(readMigrationRows(dbPath)).toEqual(before);
      expect(await opened.listProjects()).toEqual([]);
    });
  });

  it("keeps the persisted schema version across repeated reopen cycles", async () => {
    await store.initialize();
    await store.close();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const reopened = createSqliteRunnerStore({ path: dbPath });
      await withStore(reopened, async (opened) => {
        await opened.initialize();
        expect(readMigrationRows(dbPath)).toEqual([
          {
            version: 1,
            name: "initial-schema",
            appliedAt: expect.any(String),
          },
          {
            version: 2,
            name: "add-stage-runs",
            appliedAt: expect.any(String),
          },
          {
            version: 3,
            name: "add-stage-run-output",
            appliedAt: expect.any(String),
          },
          {
            version: 4,
            name: "add-resource-locks",
            appliedAt: expect.any(String),
          },
          {
            version: 5,
            name: "add-integration-queue",
            appliedAt: expect.any(String),
          },
          {
            version: 6,
            name: "add-execution-claims",
            appliedAt: expect.any(String),
          },
          {
            version: 7,
            name: "add-integration-queue-execution-identity",
            appliedAt: expect.any(String),
          },
        ]);
      });
    }
  });

  it("upgrades an older supported schema to the latest version in order", async () => {
    const legacy = createProject({ name: "legacy-project" });
    const storeA = createSqliteRunnerStore({
      path: dbPath,
      migrations: [initialSchemaMigration()],
    });
    try {
      await storeA.initialize();
      await storeA.putProject(legacy);
      await storeA.putTask(createTask());
    } finally {
      await storeA.close();
    }

    const storeB = createSqliteRunnerStore({
      path: dbPath,
      migrations: probeChain(),
    });
    await withStore(storeB, async (upgraded) => {
      await upgraded.initialize();

      expect(readMigrationRows(dbPath)).toEqual([
        {
          version: 1,
          name: "initial-schema",
          appliedAt: expect.any(String),
        },
        {
          version: 2,
          name: "test-only-create-migration-probe",
          appliedAt: expect.any(String),
        },
        {
          version: 3,
          name: "test-only-seed-migration-probe",
          appliedAt: expect.any(String),
        },
        {
          version: 4,
          name: "test-only-far-future-migration-probe",
          appliedAt: expect.any(String),
        },
        {
          version: 5,
          name: "test-only-beyond-supported-migration-probe",
          appliedAt: expect.any(String),
        },
        {
          version: 6,
          name: "test-only-beyond-supported-migration-probe-2",
          appliedAt: expect.any(String),
        },
      ]);
      expect(readProbeMarkers(dbPath)).toEqual([
        "v3-applied",
        "v4-applied",
        "v5-applied",
        "v6-applied",
      ]);
      expect(await upgraded.getProject(legacy.id)).toEqual(legacy);
      expect(await upgraded.getTask("M001")).toEqual(createTask());
    });
  });

  it("rejects a database whose schema version is newer than supported", async () => {
    const storeA = createSqliteRunnerStore({
      path: dbPath,
      migrations: [initialSchemaMigration()],
    });
    try {
      await storeA.initialize();
    } finally {
      await storeA.close();
    }
    const storeB = createSqliteRunnerStore({
      path: dbPath,
      migrations: futureSchemaChain(),
    });
    try {
      await storeB.initialize();
    } finally {
      await storeB.close();
    }

    const rejected = createSqliteRunnerStore({ path: dbPath });
    let rejection: unknown;
    try {
      await rejected.initialize();
    } catch (error) {
      rejection = error;
    } finally {
      await rejected.close();
    }

    expect(rejection).toBeInstanceOf(SchemaVersionTooNewError);
    expect((rejection as Error).message).toContain(`"${dbPath}"`);
    expect((rejection as Error).message).toContain("schema version 8");
    expect((rejection as Error).message).toContain(
      "supported schema version 7",
    );
  });

  it("rejects newer databases through the migration runner directly", () => {
    const db = new DatabaseSync(dbPath);
    try {
      expect(
        migrateSchema(db, {
          migrations: futureSchemaChain(),
          now: () => FIXED_CLOCK,
        }),
      ).toBe(8);

      expect(() =>
        migrateSchema(db, { migrations: [initialSchemaMigration()] }),
      ).toThrow(SchemaVersionTooNewError);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed upgrade without advancing the schema version", async () => {
    const legacy = createProject({ name: "legacy-project" });
    const storeA = createSqliteRunnerStore({
      path: dbPath,
      migrations: [initialSchemaMigration()],
    });
    try {
      await storeA.initialize();
      await storeA.putProject(legacy);
    } finally {
      await storeA.close();
    }

    const storeB = createSqliteRunnerStore({
      path: dbPath,
      migrations: failingProbeChain(),
    });
    let rejection: unknown;
    try {
      await storeB.initialize();
    } catch (error) {
      rejection = error;
    } finally {
      await storeB.close();
    }

    expect(rejection).toBeInstanceOf(PersistenceError);
    expect((rejection as Error).message).toBe(
      'Schema migration "test-only-invalid-sql" (version 7) failed',
    );
    expect(readMigrationRows(dbPath)).toEqual([
      { version: 1, name: "initial-schema", appliedAt: expect.any(String) },
    ]);
    expect(tableExists(dbPath, "migration_probe")).toBe(false);
    expect(tableExists(dbPath, "definitely_broken")).toBe(false);

    const recovered = createSqliteRunnerStore({
      path: dbPath,
      migrations: [initialSchemaMigration()],
    });
    await withStore(recovered, async (opened) => {
      await opened.initialize();
      expect(await opened.getProject(legacy.id)).toEqual(legacy);
    });
  });

  it("rolls back schema and data changes when a migration body throws", async () => {
    const db = new DatabaseSync(dbPath);
    try {
      expect(() =>
        migrateSchema(db, {
          migrations: [
            initialSchemaMigration(),
            {
              version: 2,
              name: "test-only-exploding-migration",
              up: (migrationDb) => {
                migrationDb.exec(
                  "CREATE TABLE IF NOT EXISTS probe_v2 (marker TEXT NOT NULL) STRICT",
                );
                migrationDb.exec(
                  "INSERT INTO probe_v2 (marker) VALUES ('half-applied')",
                );
                throw new Error("migration exploded");
              },
            },
          ],
          now: () => FIXED_CLOCK,
        }),
      ).toThrow('Schema migration "test-only-exploding-migration" (version 2) failed');
    } finally {
      db.close();
    }

    expect(tableExists(dbPath, "probe_v2")).toBe(false);
    expect(tableExists(dbPath, "projects")).toBe(false);
    expect(tableExists(dbPath, "schema_migrations")).toBe(false);

    const recovered = createSqliteRunnerStore({ path: dbPath });
    await withStore(recovered, async (opened) => {
      await opened.initialize();
      expect(readMigrationRows(dbPath)).toEqual([
        { version: 1, name: "initial-schema", appliedAt: expect.any(String) },
        { version: 2, name: "add-stage-runs", appliedAt: expect.any(String) },
        { version: 3, name: "add-stage-run-output", appliedAt: expect.any(String) },
        { version: 4, name: "add-resource-locks", appliedAt: expect.any(String) },
        { version: 5, name: "add-integration-queue", appliedAt: expect.any(String) },
        { version: 6, name: "add-execution-claims", appliedAt: expect.any(String) },
        { version: 7, name: "add-integration-queue-execution-identity", appliedAt: expect.any(String) },
      ]);
    });
  });

  it("re-running migrations on an already-migrated database is a no-op", () => {
    const db = new DatabaseSync(dbPath);
    try {
      expect(
        migrateSchema(db, {
          migrations: probeChain(),
          now: () => FIXED_CLOCK,
        }),
      ).toBe(6);
      expect(
        migrateSchema(db, {
          migrations: probeChain(),
          now: () => "2026-01-02T00:00:00.000Z",
        }),
      ).toBe(6);
    } finally {
      db.close();
    }

    expect(readMigrationRows(dbPath)).toEqual([
      {
        version: 1,
        name: "initial-schema",
        appliedAt: FIXED_CLOCK,
      },
      {
        version: 2,
        name: "test-only-create-migration-probe",
        appliedAt: FIXED_CLOCK,
      },
      {
        version: 3,
        name: "test-only-seed-migration-probe",
        appliedAt: FIXED_CLOCK,
      },
      {
        version: 4,
        name: "test-only-far-future-migration-probe",
        appliedAt: FIXED_CLOCK,
      },
      {
        version: 5,
        name: "test-only-beyond-supported-migration-probe",
        appliedAt: FIXED_CLOCK,
      },
      {
        version: 6,
        name: "test-only-beyond-supported-migration-probe-2",
        appliedAt: FIXED_CLOCK,
      },
    ]);
    expect(readProbeMarkers(dbPath)).toEqual([
      "v3-applied",
      "v4-applied",
      "v5-applied",
      "v6-applied",
    ]);
  });

  it("bootstraps a pre-migration database and preserves its data", async () => {
    const legacy = new DatabaseSync(dbPath);
    try {
      initialSchemaMigration().up(legacy);
      legacy
        .prepare(
          "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "proj-1",
          "legacy-project",
          "legacy-root",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
    } finally {
      legacy.close();
    }

    await withStore(store, async (opened) => {
      await opened.initialize();
      expect(readMigrationRows(dbPath)).toEqual([
        { version: 1, name: "initial-schema", appliedAt: expect.any(String) },
        { version: 2, name: "add-stage-runs", appliedAt: expect.any(String) },
        { version: 3, name: "add-stage-run-output", appliedAt: expect.any(String) },
        { version: 4, name: "add-resource-locks", appliedAt: expect.any(String) },
        { version: 5, name: "add-integration-queue", appliedAt: expect.any(String) },
        { version: 6, name: "add-execution-claims", appliedAt: expect.any(String) },
        { version: 7, name: "add-integration-queue-execution-identity", appliedAt: expect.any(String) },
      ]);
      expect(await opened.getProject("proj-1")).toEqual({
        id: "proj-1",
        name: "legacy-project",
        rootPath: "legacy-root",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await opened.putTask(createTask());
      expect(await opened.getTask("M001")).toEqual(createTask());
    });
  });

  it("rejects migration lists that are not sequential from version 1", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        migrateSchema(db, { migrations: [] }),
      ).toThrow("Schema migrations must not be empty");

      expect(() =>
        migrateSchema(db, {
          migrations: [
            {
              version: 2,
              name: "skips-version-1",
              up: () => undefined,
            },
          ],
        }),
      ).toThrow("Schema migrations must be sequential from version 1");
    } finally {
      db.close();
    }
  });
});
