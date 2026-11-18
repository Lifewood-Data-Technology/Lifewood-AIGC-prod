import type { Database } from "../db/database";
export type SessionFailureCode = "SESSION_EXPIRED" | "SESSION_REPLACED" | "SESSION_POLICY_CHANGED";

/** Shared by the API gate and the sign-in endpoint. Never returns token hashes. */
export async function readAccountSession(db: Database, tokenHash: string, phase: (stage: string) => void = () => {}, touch = true, tabHash?: string): Promise<{ account: Record<string, unknown> | null; code: SessionFailureCode | null }> {
  phase("session-read");
  const now = new Date();
  const row = await db.prepare(`SELECT a.email, a.name, a.initials, a.access_group, a.must_change_password, a.status,
    session.expires_at, session.last_seen_at, session.revoked_reason, session.tab_hash, session.tab_released_at
    FROM account_sessions session JOIN accounts a ON a.email = session.account_email WHERE session.token_hash = ?`)
    .bind(tokenHash).first<Record<string, unknown>>();
  const expired = { account: null, code: "SESSION_EXPIRED" as SessionFailureCode };
  if (!row || row.status !== "active" || String(row.expires_at) <= now.toISOString()) return expired;
  if (row.revoked_reason === "replaced") return { account: null, code: "SESSION_REPLACED" as SessionFailureCode };
  if (row.revoked_reason) return { account: null, code: "SESSION_POLICY_CHANGED" as SessionFailureCode };
  if (!row.tab_hash) return { account: null, code: "SESSION_POLICY_CHANGED" as SessionFailureCode };
  if (tabHash !== undefined && row.tab_hash !== tabHash) return expired;
  const released = String(row.tab_released_at || "");
  if (released) return expired;
  if (String(row.last_seen_at) <= new Date(now.getTime() - 30 * 60_000).toISOString()) return expired;
  if (touch) {
    phase("session-touch");
    const updated = await db.prepare(`UPDATE account_sessions SET last_seen_at = ?, tab_released_at = '' WHERE token_hash = ? AND revoked_reason = '' AND tab_hash = ? AND tab_released_at = ?`)
      .bind(now.toISOString(), tokenHash, row.tab_hash, released).run();
    // A replacement between the read and touch must not authenticate the old session.
    if (Number(updated.meta.changes) !== 1) return readAccountSession(db, tokenHash, phase, false, tabHash);
  }
  const { email, name, initials, access_group, must_change_password } = row;
  return { account: { email, name, initials, access_group, must_change_password }, code: null };
}

export function sessionFailureResponse(code: SessionFailureCode = "SESSION_EXPIRED") {
  return Response.json({ error: "Session is no longer available.", code }, {
    status: 401,
    headers: { "cache-control": "no-store", "x-lifewood-session-reason": code },
  });
}
