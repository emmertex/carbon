// A tiny synchronous SQL interface that both platforms implement:
//  - web:    a wrapper around sql.js (WASM, in-memory)
//  - server: a wrapper around better-sqlite3
//
// Keeping it synchronous means the whole repository layer is synchronous too — no
// `await initDB()` sprinkled through every call site like the old codebase. Both
// drivers run fully in-memory / in-process, so there is nothing to await.
//
// Always use positional `?` parameters (supported identically by both drivers).
// Never interpolate values into SQL strings.

export type SqlValue = string | number | null | bigint | Uint8Array;
export type SqlParams = SqlValue[];
export type Row = Record<string, SqlValue>;

export interface Db {
  /** Run a statement that returns nothing (INSERT/UPDATE/DELETE/DDL). */
  run(sql: string, params?: SqlParams): void;
  /** Run a query and return every row. */
  all<T = Row>(sql: string, params?: SqlParams): T[];
  /** Run a query and return the first row, or undefined. */
  get<T = Row>(sql: string, params?: SqlParams): T | undefined;
  /** Execute one or more statements with no parameters (used for schema/DDL). */
  exec(sql: string): void;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T;
}
