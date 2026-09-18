import { describe, expect, it } from "vitest";
import { configureSqliteConnection } from "../src/sqlite/sqlite-runner-store.js";

describe("SQLite startup configuration", () => {
  it("sets busy_timeout before enabling WAL", () => {
    const statements: string[] = [];

    configureSqliteConnection(
      { exec: (sql) => statements.push(sql) },
      4321,
    );

    expect(statements).toEqual([
      "PRAGMA busy_timeout = 4321;",
      "PRAGMA journal_mode = WAL;",
    ]);
  });
});
