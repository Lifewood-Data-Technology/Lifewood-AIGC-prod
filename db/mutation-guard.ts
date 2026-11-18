import type { Database, DatabaseStatement } from "./database";
import { PublicError } from "../lib/security-controls";

/** Database batches are atomic; failed guards roll back writes, notifications and audit together. */
export async function guardedMutation(db: Database, condition: string, values: (string | number | null)[], statements: DatabaseStatement[]) {
  const token = crypto.randomUUID();
  try {
    return await db.batch([
      db.prepare(`INSERT INTO mutation_guards (id, satisfied) SELECT ?, CASE WHEN (${condition}) THEN 1 ELSE 0 END`).bind(token, ...values),
      ...statements,
      db.prepare("DELETE FROM mutation_guards WHERE id = ?").bind(token),
    ]);
  } catch (error) {
    if (error instanceof Error && /(?:CHECK constraint failed.*mutation_guard_current|Check constraint ['"]mutation_guard_current['"] is violated)/i.test(error.message))
      throw new PublicError("Record changed or has unfinished work. Refresh and review before saving.", 409, "STALE_RECORD");
    throw error;
  }
}
