export class PersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersistenceError";
  }
}

export class StoreClosedError extends PersistenceError {
  constructor(operation: string) {
    super(`Cannot perform "${operation}": store is closed`);
    this.name = "StoreClosedError";
  }
}

export class SchemaVersionTooNewError extends PersistenceError {
  constructor(
    databaseVersion: number,
    supportedVersion: number,
    source?: string | undefined,
  ) {
    super(
      `SQLite database${source === undefined ? "" : ` at "${source}"`} has schema version ${String(databaseVersion)}, which is newer than the supported schema version ${String(supportedVersion)}`,
    );
    this.name = "SchemaVersionTooNewError";
  }
}
