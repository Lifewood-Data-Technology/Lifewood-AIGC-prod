import { prepareAuditStatement } from "../db/audit-write";
import { auditRequestContext } from "../db/audit-context";
import type { Database } from "../db/database";
import { presenceState, type AccessRow, type ClientInfo, type LoginEvent } from "./account-access";

/** Wait briefly for observability, never indefinitely hold authentication. */
export async function settleObservation(pending: Promise<unknown>, timeoutMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending.then(() => true, () => false), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

export async function saveLoginEvent(db: Database, email: string, event: LoginEvent, client: ClientInfo, sessionHash = "", timing?: {durationMs: number}) {
  const now = new Date().toISOString();
  const normalized = email.trim().toLowerCase();
  const statements = [db.prepare(`INSERT INTO account_login_history (id, account_email, occurred_at, event, ip_address, browser, os)
    SELECT ?, email, ?, ?, ?, ?, ? FROM accounts WHERE email = ?`)
    .bind(crypto.randomUUID(), now, event, client.ip, client.browser, client.os, normalized)];
  if (["signed_in", "resumed"].includes(event)) {
    statements.push(db.prepare(`INSERT INTO account_presence (token_hash, account_email, login_ip, current_ip, browser, os, last_contact_at, last_activity_at, visible)
      SELECT token_hash, account_email, ?, ?, ?, ?, ?, ?, 1 FROM account_sessions WHERE token_hash = ? AND account_email = ? AND revoked_reason = ''
      ON CONFLICT(token_hash) DO UPDATE SET login_ip = excluded.login_ip, current_ip = excluded.current_ip, browser = excluded.browser, os = excluded.os,
      last_contact_at = excluded.last_contact_at, last_activity_at = excluded.last_activity_at, visible = 1`)
      .bind(client.ip, client.ip, client.browser, client.os, now, now, sessionHash, normalized));
    statements.push(db.prepare("UPDATE accounts SET last_sign_in = ? WHERE email = ?").bind(now, normalized));
    // Build the correlation locally: a delayed history write must not borrow an
    // expired HTTP context or lose metadata when authentication returns first.
    const context = timing && Number.isSafeInteger(timing.durationMs) && timing.durationMs >= 0
      ? {requestId: crypto.randomUUID(), actorEmail: normalized, ipAddress: client.ip || null, active: true} : null;
    const prepare = () => prepareAuditStatement(db, "INSERT INTO audit_logs (action, actor_email, subject, details, created_at) VALUES ('session.signed_in', ?, ?, ?, ?)")
      .bind(normalized, normalized, event === "resumed" ? "Original browser session recovered" : "Password sign-in", now);
    statements.push(context ? auditRequestContext.run(context, prepare) : prepare());
    if (context) statements.push(db.prepare("INSERT INTO audit_request_metadata (request_id, ip_address, outcome, duration_ms, error_code) SELECT ?, ?, 'success', ?, NULL WHERE EXISTS (SELECT 1 FROM audit_logs WHERE request_id = ?)")
      .bind(context.requestId, context.ipAddress, timing!.durationMs, context.requestId));
  }
  // Bounded, per-account history; never persist attempted addresses for unknown accounts.
  statements.push(db.prepare(`DELETE FROM account_login_history WHERE account_email = ? AND (occurred_at < ? OR id NOT IN
    (SELECT id FROM (SELECT id FROM account_login_history WHERE account_email = ? ORDER BY occurred_at DESC, id DESC LIMIT 100) retained_history))`)
    .bind(normalized, new Date(Date.now() - 90 * 86400000).toISOString(), normalized));
  // Keep the latest contact for offline accounts too, bounded to one snapshot.
  statements.push(db.prepare(`DELETE FROM account_presence WHERE account_email = ? AND (last_contact_at < ? OR token_hash NOT IN
    (SELECT token_hash FROM (SELECT token_hash FROM account_presence WHERE account_email = ? ORDER BY last_contact_at DESC, token_hash DESC LIMIT 1) retained_presence))`)
    .bind(normalized, new Date(Date.now() - 90 * 86400000).toISOString(), normalized));
  await db.batch(statements);
}

/** Heartbeats must never refresh the authentication idle timeout or resurrect a session. */
export async function saveAccountPresence(db: Database, tokenHash: string, tabHash: string, active: boolean, visible: boolean, client: ClientInfo) {
  const now = new Date().toISOString();
  const update = db.prepare(`INSERT INTO account_presence (token_hash, account_email, login_ip, current_ip, browser, os, last_contact_at, last_activity_at, visible)
    SELECT s.token_hash, s.account_email, '', ?, ?, ?, ?, ?, ? FROM account_sessions s JOIN accounts a ON a.email = s.account_email
    WHERE s.token_hash = ? AND s.tab_hash = ? AND s.tab_hash <> '' AND s.tab_released_at = '' AND s.revoked_reason = '' AND s.expires_at > ? AND s.last_seen_at > ? AND a.status = 'active'
    ON CONFLICT(token_hash) DO UPDATE SET current_ip = excluded.current_ip, browser = excluded.browser, os = excluded.os, last_contact_at = excluded.last_contact_at,
    last_activity_at = CASE WHEN ? THEN excluded.last_activity_at ELSE account_presence.last_activity_at END, visible = excluded.visible`)
    .bind(client.ip, client.browser, client.os, now, active ? now : null, visible ? 1 : 0, tokenHash, tabHash, now,
      new Date(Date.now() - 30 * 60_000).toISOString(), active ? 1 : 0);
  const result = await update.run();
  return Number(result.meta.changes) === 1;
}

export async function readAccountAccess(db: Database, now = Date.now()): Promise<AccessRow[]> {
  const iso = new Date(now).toISOString();
  const rows = (await db.prepare(`SELECT a.email, a.name, a.access_group, a.status, a.last_sign_in,
    s.created_at, s.expires_at, s.last_seen_at, p.last_contact_at, p.last_activity_at, p.visible, p.login_ip, p.current_ip, p.browser, p.os
    FROM accounts a LEFT JOIN account_sessions s ON s.account_email = a.email AND s.revoked_reason = '' AND s.tab_hash <> '' AND s.tab_released_at = '' AND s.expires_at > ? AND s.last_seen_at > ?
    LEFT JOIN account_presence p ON p.token_hash = COALESCE(s.token_hash,
      (SELECT token_hash FROM account_presence WHERE account_email = a.email AND last_contact_at >= ? ORDER BY last_contact_at DESC, token_hash DESC LIMIT 1))
    ORDER BY a.name, a.email`)
    .bind(iso, new Date(now - 30 * 60_000).toISOString(), new Date(now - 90 * 86400000).toISOString()).all<Record<string, unknown>>()).results;
  const str = (v: unknown) => typeof v === "string" ? v : "";
  return rows.map(row => {
    const online = row.status === "active" && !!row.expires_at;
    return {
      email: str(row.email), name: row.access_group === "system" ? "系统管理员" : str(row.name), group: str(row.access_group), status: str(row.status),
      presence: presenceState({ ...row, status: str(row.status) }, now), lastSignIn: str(row.last_sign_in) || null,
      sessionStartedAt: online ? str(row.created_at) || null : null, sessionExpiresAt: online ? str(row.expires_at) || null : null,
      lastContactAt: str(row.last_contact_at) || null, lastActivityAt: str(row.last_activity_at) || null,
      loginIp: online ? str(row.login_ip) : "", currentIp: online ? str(row.current_ip) : "", browser: online ? str(row.browser) : "", os: online ? str(row.os) : "",
    };
  });
}
