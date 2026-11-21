// An in-memory SQLite database with every table of the current MySQL schema contract (columns, NOT NULL,
// defaults, primary keys, unique indexes and CHECK constraints). Lets whole-business services such as permanent
// deletion run against the real table set with synthetic rows only.
import contract from "../../db/mysql/schema-contract.json" with { type: "json" };
import { sqliteDatabase } from "./sqlite-database";

type Column = { name: string; type: string; primaryKey?: boolean; notNull?: boolean; default?: unknown };
type Table = { name: string; columns: Record<string, Column>; indexes: Record<string, { name: string; columns: string[]; isUnique: boolean; where?: string }>; checkConstraints: Record<string, { name: string; value: string }> };

export function contractDatabase() {
  const db = sqliteDatabase();
  for (const table of Object.values(contract.tables as Record<string, Table>)) {
    const columns = Object.values(table.columns).map(column => `"${column.name}" ${column.type === "integer" ? "INTEGER" : column.type === "real" ? "REAL" : "TEXT"}` +
      `${column.primaryKey ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}${"default" in column ? ` DEFAULT (${String(column.default)})` : ""}`);
    const checks = Object.values(table.checkConstraints).map(check => `CONSTRAINT "${check.name}" CHECK (${check.value})`);
    db.sqlite.exec(`CREATE TABLE "${table.name}" (${[...columns, ...checks].join(", ")})`);
    for (const index of Object.values(table.indexes))
      db.sqlite.exec(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX "${index.name}" ON "${table.name}" (${index.columns.map(column => `"${column}"`).join(", ")})${index.where ? ` WHERE ${index.where}` : ""}`);
  }
  /** Inserts one row, filling NOT NULL columns without defaults with neutral values. */
  function insert(tableName: string, values: Record<string, unknown>) {
    const table = (contract.tables as Record<string, Table>)[tableName];
    if (!table) throw new Error(`Unknown table ${tableName}`);
    const row: Record<string, unknown> = {};
    for (const column of Object.values(table.columns)) {
      if (column.name in values) row[column.name] = values[column.name];
      else if (column.notNull && !("default" in column)) row[column.name] = column.type === "text" ? "" : 0;
    }
    for (const key of Object.keys(values)) if (!(key in table.columns)) throw new Error(`Unknown column ${tableName}.${key}`);
    const names = Object.keys(row);
    db.sqlite.prepare(`INSERT INTO "${tableName}" (${names.map(name => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map(name => row[name] as never));
  }
  const count = (tableName: string, where = "1=1", ...values: unknown[]) => Number((db.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${tableName}" WHERE ${where}`).get(...values as never[]) as { n: number }).n);
  return Object.assign(db, { insert, count });
}
