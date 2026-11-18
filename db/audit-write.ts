import type { Database, DatabaseStatement } from "./database";
import { currentAuditRequestId } from "./audit-context";

/** Add request correlation without moving the original audit out of its business transaction.
 * The SQL must be a fixed audit INSERT. Both VALUES and conditional INSERT SELECT keep their
 * original parameter order, predicates and changes() semantics. Background/historical callers
 * without an HTTP context continue to write the original fields, with request_id left NULL.
 */
export function prepareAuditStatement(db: Database, sql: string): Pick<DatabaseStatement, "bind"> {
  const insert = /^(\s*INSERT\s+INTO\s+audit_logs\s*\()(\s*action\s*,\s*actor_email\s*,\s*subject\s*,\s*details\s*,\s*created_at\s*)(\)\s*)(VALUES\s*\(|SELECT\s+)/i;
  if (!insert.test(sql)) throw new Error("Unsupported audit insert shape");
  const requestId = currentAuditRequestId();
  if (!requestId) return db.prepare(sql);
  const correlated = sql.replace(insert, (_, opening: string, columns: string, closing: string, source: string) => `${opening}request_id, ${columns}${closing}${source}?, `);
  return { bind: (...values: unknown[]) => db.prepare(correlated).bind(requestId, ...values) };
}
