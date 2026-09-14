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
