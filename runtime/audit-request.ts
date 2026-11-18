import type { Database, DatabaseStatement } from "../db/database";
import { auditRequestContext, type AuditRequestContext } from "../db/audit-context";
import { prepareAuditStatement } from "../db/audit-write";
import { safeIp } from "../lib/account-access";
import { PublicError } from "../lib/security-controls";

/** Fixed mutation routes only: never log search, polling, cookies, submitted bodies or file bytes. */
export const auditedMutationRoutes: Readonly<Record<string, string>> = {
  "/api/accounts": "accounts", "/api/admin-directory": "directory", "/api/settings": "settings",
  "/api/mfa": "mfa", "/api/backups": "backups", "/api/workflow": "workflow",
  "/api/direct-uploads": "direct-uploads",
  "/api/deseret-book": "workflow",
  "/api/files": "files", "/api/folders": "folders", "/api/production-workspace": "production",
  "/api/request-documents": "documents", "/api/request-analysis": "analysis",
  "/api/business-deletion": "business-deletion", "/api/business-recycle": "recycle",
  "/api/name-translations": "name-translations", "/api/content-translations": "content-translations",
  "/api/shares": "shares", "/api/audit": "audit", "/api/admin-login-log": "login-log",
  "/api/admin-logs/deletion": "logs",
};
type Outcome = "success" | "failure" | "unconfirmed";
const safeCode = (value: unknown): string | null => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const uncertainCode = (code: string | null) => Boolean(code && /(?:UNCONFIRMED|RESULT_UNKNOWN|PENDING_VERIFICATION)/.test(code));

/** Read only a bounded error envelope, not successful response data or request inputs. */
async function responseErrorCode(response: Response): Promise<string | null> {
  if (response.status < 400 || !response.headers.get("content-type")?.includes("application/json")) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8192) { void reader.cancel(); return null; }
      chunks.push(next.value);
    }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    const body: unknown = JSON.parse(new TextDecoder().decode(buffer));
    return body && typeof body === "object" && "code" in body ? safeCode(body.code) : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function finishAudit(db: Database, context: AuditRequestContext, route: string, method: string, status: number, errorCode: string | null, durationMs: number) {
  // Count committed records, not constructed statements: failed guards and rolled-back batches
  // must never be mistaken for successful operations.
  const committed = Number((await db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE request_id = ?").bind(context.requestId).first<{ total: number }>())?.total || 0);
  const uncertain = uncertainCode(errorCode) || status === 202 || status >= 500 || (status >= 400 && committed > 0);
  const outcome: Outcome = uncertain ? "unconfirmed" : status >= 400 ? "failure" : "success";
  if (!committed && outcome === "success") return; // Successful no-op or unrecorded helper: do not invent a business event.
  const statements: DatabaseStatement[] = [];
  if (!committed) statements.push(prepareAuditStatement(db, "INSERT INTO audit_logs (action, actor_email, subject, details, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(`request.${auditedMutationRoutes[route]}.${outcome}`, context.actorEmail, route, JSON.stringify({ method, status, ...(errorCode ? { code: errorCode } : {}) }), new Date().toISOString()));
  // A log may have been permanently deleted after the count above. Resolve this predicate
  // inside the same atomic batch as any new failure record; never resurrect orphan metadata.
  statements.push(db.prepare("INSERT INTO audit_request_metadata (request_id, ip_address, outcome, duration_ms, error_code) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_logs WHERE request_id = ?)")
    .bind(context.requestId, context.ipAddress, outcome, durationMs, errorCode, context.requestId));
  await db.batch(statements);
}

/** Must be invoked after authenticatedResponse has replaced identity and source headers. */
export async function auditMutationResponse(request: Request, db: Database, handle: (request: Request) => Promise<Response>): Promise<Response> {
  const route = new URL(request.url).pathname.replace(/^\/api\/direct-uploads\/[^/]+$/, "/api/direct-uploads"), actorEmail = request.headers.get("x-lifewood-actor-email") || "";
  if (!auditedMutationRoutes[route] || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || !actorEmail) return handle(request);
  const context: AuditRequestContext = { requestId: crypto.randomUUID(), actorEmail, ipAddress: safeIp(request.headers.get("x-lifewood-client-ip")) || null, active: true };
  return auditRequestContext.run(context, async () => {
    const started = performance.now(); let response: Response | undefined, thrown: unknown, failed = false;
    try { response = await handle(request); }
    catch (error) { failed = true; thrown = error; }
    // Duration ends when the handler produces a response or throws; exclude audit persistence,
    // network transfer and detached background work. Never use client-provided timings.
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const code = failed ? thrown instanceof PublicError ? safeCode(thrown.code) : "INTERNAL_ERROR" : await responseErrorCode(response!);
    const status = failed ? thrown instanceof PublicError ? thrown.status : 500 : response!.status;
    try { await finishAudit(db, context, route, request.method, status, code, durationMs); }
    catch { console.error({ event: "audit.metadata.unavailable", requestId: context.requestId }); }
    finally { context.active = false; }
    // An audit-store outage cannot turn an already committed action into a retryable business
    // error. Its existing audit stays visible with missing metadata; never report fake success.
    if (failed) throw thrown;
    return response!;
  });
}
