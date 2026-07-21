/**
 * BunSqliteAdapter — `bun:sqlite` implementation of core's `SqliteAdapter` (doc 11/13).
 *
 * This is the concrete DB driver behind the runtime-coupled seam. Keeping every SQLite
 * access in the runtime behind `SqliteAdapter` means a move to Deno/Node (`node:sqlite`)
 * later is a one-file swap. `bun:sqlite` gives us synchronous access, FTS5 + `bm25()`,
 * and single-file portability with zero dependencies.
 */
import { Database } from "bun:sqlite";
import type { SqliteAdapter, SqliteParams, SqliteStatement } from "@akko/core";

export class BunSqliteAdapter implements SqliteAdapter {
  readonly #db: Database;

  constructor(path = ":memory:") {
    this.#db = new Database(path);
    // WAL is a good default for concurrent readers alongside a single writer.
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.#db.query(sql);
    return {
      run(...params: SqliteParams) {
        const result = stmt.run(...(params as never[]));
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
      get<T = unknown>(...params: SqliteParams): T | undefined {
        return (stmt.get(...(params as never[])) as T | null) ?? undefined;
      },
      all<T = unknown>(...params: SqliteParams): T[] {
        return stmt.all(...(params as never[])) as T[];
      },
    };
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  close(): void {
    this.#db.close();
  }
}
