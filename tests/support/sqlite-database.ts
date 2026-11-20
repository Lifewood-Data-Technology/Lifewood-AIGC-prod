// In-memory Database adapter for tests. batch() is one transaction, matching the production contract
// that guardedMutation relies on: a failed guard or statement rolls every write back together.
import { DatabaseSync } from "node:sqlite";
import type { Database, DatabaseResult, DatabaseStatement } from "../../db/database";

type Row = Record<string, unknown>;

export function sqliteDatabase(sqlite = new DatabaseSync(":memory:")): Database & { sqlite: DatabaseSync } {
  const statement = (sql: string, values: unknown[] = []): DatabaseStatement => {
    const params = values as never[];
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      async first<T>(column?: string) {
        const row = sqlite.prepare(sql).get(...params) as Row | undefined;
        return (row ? (column ? row[column] : row) : null) as T | null;
      },
      async all<T>() {
        const result: DatabaseResult<T> = { results: sqlite.prepare(sql).all(...params) as T[], success: true, meta: { changes: 0 } };
        return result;
      },
      async run<T>() {
        const changes = sqlite.prepare(sql).run(...params).changes;
        const result: DatabaseResult<T> = { results: [], success: true, meta: { changes: Number(changes) } };
        return result;
      },
      async raw<T>() {
        return (sqlite.prepare(sql).all(...params) as Row[]).map(row => Object.values(row)) as T[];
      },
    };
  };
  return {
    sqlite,
    prepare: sql => statement(sql),
    async batch<T>(statements: DatabaseStatement[]) {
      sqlite.exec("BEGIN");
      try {
        const results: DatabaseResult<T>[] = [];
        for (const item of statements) results.push(await item.run<T>());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
