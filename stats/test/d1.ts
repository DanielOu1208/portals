import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import type { D1Database, D1Statement, D1Value } from "../src/d1.ts";
import type { Limiter } from "../src/d1.ts";

// Stand-ins for the Worker's bindings. D1 is SQLite, so the stand-in is SQLite too (Node's
// own, in memory) with the migrations applied, and the Worker's SQL runs as it would on D1.

export function testDatabase(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(folder, file), "utf8"));
  }

  function statement(sql: string, values: D1Value[]): D1Statement {
    const run = () => sqlite.prepare(sql).run(...(values as SQLInputValue[]));
    return {
      bind: (...bound) => statement(sql, bound),
      run: async () => run(),
      all: async <Row>() => ({ results: sqlite.prepare(sql).all(...(values as SQLInputValue[])) as Row[] }),
      first: async <Row>() => (sqlite.prepare(sql).get(...(values as SQLInputValue[])) as Row | undefined) ?? null,
      // How batch runs it, inside its transaction.
      [runInBatch]: run,
    } as D1Statement;
  }

  return {
    sqlite,
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((item) => (item as unknown as { [runInBatch]: () => unknown })[runInBatch]());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const runInBatch = Symbol("run in batch");

/** A `ratelimits` binding that lets `allowed` requests through per key, then no more. */
export function testLimiter(allowed: number): Limiter & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= allowed };
    },
  };
}
