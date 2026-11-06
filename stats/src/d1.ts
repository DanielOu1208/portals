// The few D1 and Workers APIs the stats Worker uses, as far as it uses them: its types are
// Node's (tsconfig.json), and there is no dependency for Cloudflare's. The tests hand in a
// stand-in on node:sqlite (test/d1.ts) with the same shape.

export type D1Value = string | number | null;

export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  run(): Promise<unknown>;
  all<Row = Record<string, D1Value>>(): Promise<{ results: Row[] }>;
  first<Row = Record<string, D1Value>>(): Promise<Row | null>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
  /** Runs the statements in order as one transaction: all of them or none. */
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

/** A `ratelimits` binding: `success` is false once a key has had its share. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
