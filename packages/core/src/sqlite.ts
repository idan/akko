/**
 * SqliteAdapter — the single runtime-coupled seam.
 *
 * The runtime evaluation (docs/architecture/11-runtime-evaluation.md) chose Bun as the
 * default. The ONLY place that choice leaks is the native SQLite driver:
 *   - Bun  → `bun:sqlite`   (default)
 *   - Node → `node:sqlite`
 *   - Deno → `node:sqlite`
 *
 * All three expose FTS5 + a synchronous prepare/run/get/all shape, so this tiny
 * interface abstracts them. Keep every SQLite access in `core` behind it, and moving
 * to Deno (or Node) later is a one-adapter swap — never a rearchitecture. This is the
 * concrete guarantee behind "if we ever want Deno, it should be easy".
 *
 * This file is interface-only. The concrete `bun:sqlite` implementation lives in the
 * data/storage layer (a future package), not here, so `core` stays runtime-agnostic.
 */

/** A prepared statement. Parameters may be positional or a single named-params object. */
export interface SqliteStatement {
  run(...params: SqliteParams): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: SqliteParams): T | undefined;
  all<T = unknown>(...params: SqliteParams): T[];
}

export type SqliteParam = string | number | bigint | boolean | null | Uint8Array;
export type SqliteParams = SqliteParam[] | [Record<string, SqliteParam>];

/**
 * Minimal synchronous SQLite handle. Both `bun:sqlite` (`Database`) and `node:sqlite`
 * (`DatabaseSync`) satisfy this with a thin wrapper.
 */
export interface SqliteAdapter {
  /** Execute one or more statements with no result (DDL, PRAGMA, etc.). */
  exec(sql: string): void;

  /** Compile a statement for repeated execution. */
  prepare(sql: string): SqliteStatement;

  /**
   * Run `fn` inside a transaction (BEGIN/COMMIT, ROLLBACK on throw). Implementations
   * may delegate to the driver's own transaction helper.
   */
  transaction<T>(fn: () => T): T;

  /** Close the underlying database handle. */
  close(): void;
}

/**
 * Opens a SqliteAdapter for a database file (or `:memory:`). Implemented once per
 * runtime driver; `core` only ever depends on this signature.
 */
export type SqliteOpen = (path: string) => SqliteAdapter;
