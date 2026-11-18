import type {Database} from "../db/database";
import {guardedMutation} from "../db/mutation-guard";
interface CleanupBucket { list(options: {cursor?: string; limit: number}): Promise<{objects: {key: string; size: number; etag?: string}[]; truncated: boolean; cursor?: string}>; delete(keys: string[]): Promise<void>; }
/** Temporary owner-authorized maintenance operation. Never expose as a permanent app API.
 * Only explicitly enumerated demo tables and the configured Wasabi object scope can be cleared.
 * The maintenance hook and runtime credential must be removed after the verified run.
 */
export const CLEANUP_PATH = "/__maintenance/demo-cleanup";
export const PRESERVED_TABLES = ["accounts", "account_credentials", "account_mfa", "account_permissions", "account_sessions", "account_presence", "account_login_history", "login_attempts", "security_rate_limits", "editor_workspaces", "settings", "mutation_guards",
  "admin_log_deletion_previews", "admin_log_deletion_receipts", "audit_request_metadata", "business_deletion_jobs", "business_deletion_locks", "business_deletion_objects", "business_deletion_operations", "business_deletion_records", "direct_upload_sessions",
  "deseret_project_links", "deseret_inbox", "deseret_outbox", "deseret_material_tasks", "deseret_handoff_history"] as const;
export const DEMO_TABLES = [
  "business_name_translations",
  "production_flow_files", "production_flow_events",
  "production_final_submission_files", "production_final_submissions", "production_submission_receipts", "production_staged_files",
  "share_access_sessions", "share_links", "asset_collection_files", "asset_lineage", "asset_collections",
  "production_checkpoint_files", "checkpoint_environment_snapshots", "task_material_links", "handover_records",
  "production_checkpoint_drafts", "production_checkpoints", "upload_sessions", "aigc_file_operations",
  "aigc_file_previews", "aigc_file_versions", "aigc_files", "aigc_storage_objects",
  "project_request_analyses", "project_request_documents", "project_request_revisions", "project_requests",
  "quality_rounds", "reviews", "feedback", "deliveries", "publish_records", "project_files",
  "language_assignment_history", "language_projects", "project_videos", "material_standards", "project_types",
  "versions", "notifications", "audit_logs", "workflow_submissions", "account_login_intents", "projects", "client_profiles", "clients",
] as const;
export const ROOT_FOLDERS = ["folder-library-root", "folder-library-final", "folder-library-public", "folder-library-video", "folder-library-image", "folder-library-audio", "folder-library-template", "folder-library-ai", "folder-library-music", "folder-library-sfx", "folder-library-voice"] as const;
const folderCondition = "id NOT IN (" + ROOT_FOLDERS.map(() => "?").join(",") + ")";
const names = [...PRESERVED_TABLES, ...DEMO_TABLES, "aigc_folders"].sort();
const preservedOrder: Record<string, string> = { accounts: "id", account_credentials: "email", account_mfa: "account_email", account_permissions: "id", account_sessions: "token_hash", account_presence: "token_hash", account_login_history: "id", login_attempts: "email", security_rate_limits: "key", editor_workspaces: "id", settings: "key", mutation_guards: "id",
  admin_log_deletion_previews: "id", admin_log_deletion_receipts: "id", audit_request_metadata: "request_id", business_deletion_jobs: "id", business_deletion_locks: "scope_id", business_deletion_objects: "id", business_deletion_operations: "id", business_deletion_records: "id", direct_upload_sessions: "id",
  deseret_project_links: "id", deseret_inbox: "id", deseret_outbox: "sequence", deseret_material_tasks: "id", deseret_handoff_history: "id" };
// Any integration history blocks this legacy cleaner, including completed jobs.
// It has no authority to erase replay receipts or detach cross-platform records.
const maintenanceIdle = `NOT EXISTS(SELECT 1 FROM deseret_project_links)
  AND NOT EXISTS(SELECT 1 FROM deseret_inbox)
  AND NOT EXISTS(SELECT 1 FROM deseret_outbox)
  AND NOT EXISTS(SELECT 1 FROM deseret_material_tasks)
  AND NOT EXISTS(SELECT 1 FROM deseret_handoff_history)
  AND NOT EXISTS(SELECT 1 FROM business_deletion_jobs WHERE state NOT IN ('complete','rejected'))
  AND NOT EXISTS(SELECT 1 FROM business_deletion_operations)
  AND NOT EXISTS(SELECT 1 FROM direct_upload_sessions WHERE claim_id IS NOT NULL OR (state <> 'ready' AND (state NOT IN ('cancelled','expired') OR cleaned_at IS NULL)))`;
async function requireIdle(db: Database) {
  if (Number((await db.prepare(`SELECT CASE WHEN (${maintenanceIdle}) THEN 1 ELSE 0 END AS idle`).first<{idle:number}>())?.idle) !== 1) throw new Error("ACTIVE_WORK_REMAINS");
}
export interface CleanupEnv { DB: Database; FILES: CleanupBucket; AIGC_DEMO_CLEANUP_TOKEN?: string; AIGC_DEMO_CLEANUP_EXPIRES?: string; AIGC_DEMO_CLEANUP_MODE?: string;
  /** Server-owned native adapter; must reject unknown tables/triggers before returning. Never read from a request. */
  reviewedMysqlInventory: () => Promise<{schema: {name:string;type:string;sql:string}[]; ledgers: unknown[]; storage: {provider:string;bucket:string;endpoint:string}}>;
}
class InventoryScopeError extends Error {
  constructor(readonly item: string) { super("SCHEMA_SCOPE_CHANGED"); }
}
export function cleanupDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const known = ["SCHEMA_SCOPE_CHANGED", "BASE_FOLDERS_CHANGED", "EXTERNAL_STORAGE_NOT_IN_SCOPE", "OBJECT_SCOPE_TOO_LARGE", "INVALID_OBJECT_INVENTORY", "PRESERVED_DATA_CHANGED", "CLEANUP_VERIFY_FAILED", "ACTIVE_WORK_REMAINS"];
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const detail = message + " " + cause;
  const fallback = /too many (subrequests|queries)|limit exceeded/i.test(detail) ? "REQUEST_LIMIT" : /no such (table|column)|SQLITE_ERROR/i.test(detail) ? "DATABASE_QUERY_FAILED" : /cannot read properties of undefined/i.test(detail) ? "BINDING_UNAVAILABLE" : "CHECK_FAILED";
  return { code: known.includes(message) ? message : fallback, ...(error instanceof InventoryScopeError ? { item: error.item.replace(/[^a-zA-Z0-9_,: -]/g, "").slice(0, 500) } : {}) };
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
async function authorized(request: Request, env: CleanupEnv) {
  const token = env.AIGC_DEMO_CLEANUP_TOKEN ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  const expiry = Date.parse(env.AIGC_DEMO_CLEANUP_EXPIRES ?? "");
  if (!/^[a-f0-9]{64}$/.test(token) || !Number.isFinite(expiry) || Date.now() >= expiry || supplied.length !== 71) return false;
  const a = await hash(supplied), b = await hash("Bearer " + token);
  let delta = 0; for (let i = 0; i < a.length; i++) delta |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return delta === 0;
}
async function objects(bucket: CleanupBucket) {
  const result: { key: string; etag: string; bytes: number }[] = []; let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) result.push({ key: object.key, etag: object.etag ?? "", bytes: object.size });
    if (result.length > 10000) throw new Error("OBJECT_SCOPE_TOO_LARGE");
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && (!cursor || cursors.has(cursor))) throw new Error("INVALID_OBJECT_INVENTORY");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
export async function inventory(env: CleanupEnv, observe?: (stage: string) => void) {
  const db = env.DB;
  observe?.("schema");
  // No legacy fallback: the server-owned adapter must verify the native schema
  // and trigger definitions before any inventory or deletion can proceed.
  if (typeof env.reviewedMysqlInventory !== "function") throw new Error("SCHEMA_SCOPE_CHANGED");
  const mysqlInventory = await env.reviewedMysqlInventory();
  const schema = mysqlInventory.schema;
  const actual = schema.filter(row => row.type === "table").map(row => row.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw new InventoryScopeError("extra:" + actual.filter(name => !names.includes(name as typeof names[number])).join(",") + ";missing:" + names.filter(name => !actual.includes(name)).join(","));
  if (schema.some(row => row.type === "view")) throw new InventoryScopeError("view:" + schema.filter(row => row.type === "view").map(row => row.name).join(","));
  observe?.("counts");
  const counts = await db.batch(names.map(name => db.prepare('SELECT COUNT(*) AS n FROM "' + name + '"')));
  const tables = Object.fromEntries(names.map((name, index) => [name, Number((counts[index].results[0] as { n: number }).n)]));
  await requireIdle(db);
  observe?.("protected_data");
  const preserved = await db.batch(PRESERVED_TABLES.map(name => db.prepare('SELECT * FROM "' + name + '"' + (name === "settings" ? " WHERE key <> 'businessDataResetCompletedAt'" : "") + ' ORDER BY "' + preservedOrder[name] + '"')));
  const platformRows = mysqlInventory.ledgers.map(row => JSON.stringify(row)).sort();
  observe?.("base_folders");
  const roots = (await db.prepare("SELECT * FROM aigc_folders WHERE NOT (" + folderCondition + ") ORDER BY id").bind(...ROOT_FOLDERS).all()).results;
  if (roots.length !== ROOT_FOLDERS.length || roots.some(row => row.deleted_at || row.client_id || row.project_id || row.language_project_id || row.video_id)) throw new Error("BASE_FOLDERS_CHANGED");
  observe?.("storage_scope");
  const foreignStorage = (await db.prepare("SELECT COUNT(*) AS n FROM aigc_storage_objects WHERE provider <> ? OR bucket_name <> ? OR NOT (endpoint_url IS ?)")
    .bind(mysqlInventory.storage.provider, mysqlInventory.storage.bucket, mysqlInventory.storage.endpoint).first<{ n: number }>())?.n ?? 0;
  if (foreignStorage) throw new Error("EXTERNAL_STORAGE_NOT_IN_SCOPE");
  observe?.("file_inventory");
  const files = await objects(env.FILES);
  observe?.("checksums");
  const preservedHash = await hash([preserved.map(result => result.results), roots, platformRows]);
  const planHash = await hash([schema, tables, files, preservedHash]);
  return { tables, roots: roots.length, files, preservedHash, planHash };
}
export function publicPlan(plan: Awaited<ReturnType<typeof inventory>>) {
  return { tables: plan.tables, preservedHash: plan.preservedHash, planHash: plan.planHash, fileCount: plan.files.length, fileBytes: plan.files.reduce((sum, file) => sum + file.bytes, 0), keptBaseFolders: plan.roots, foldersToDelete: plan.tables.aigc_folders - plan.roots };
}
export async function handleDemoCleanup(request: Request, env: CleanupEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CLEANUP_PATH) {
    if (!env.AIGC_DEMO_CLEANUP_TOKEN || env.AIGC_DEMO_CLEANUP_MODE !== "execute") return null;
    // Block all application access, including public file links and sign-in,
    // during this temporary run. No requests can regenerate demo records.
    return new Response("系统正在清理演示数据，请稍后刷新。账号和密码会保留。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "60" } });
  }
  if (!await authorized(request, env)) return json({ error: "NOT_FOUND" }, 404);
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) return json({ error: "ORIGIN_REJECTED" }, 403);
  try {
    if (request.method === "GET") return json(publicPlan(await inventory(env)));
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (env.AIGC_DEMO_CLEANUP_MODE !== "execute") return json({ error: "PREVIEW_ONLY" }, 403);
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: "INVALID_COMMAND" }, 400);
    const body = JSON.parse(raw) as { operation?: string; confirmation?: string; backupWaived?: boolean; planHash?: string; preservedHash?: string };
    if (!["files", "database"].includes(body.operation ?? "") || body.confirmation !== "CLEAR_DEMO_KEEP_ACCOUNTS" || body.backupWaived !== true || !/^[a-f0-9]{64}$/.test(body.planHash ?? "") || !/^[a-f0-9]{64}$/.test(body.preservedHash ?? "")) return json({ error: "INVALID_COMMAND" }, 400);
    const before = await inventory(env);
    if (body.planHash !== before.planHash || body.preservedHash !== before.preservedHash) return json({ error: "PLAN_CHANGED" }, 409);
    if (body.operation === "files") {
      // Bounded, exact enumerated keys; never accept arbitrary bucket/key input.
      const batch = before.files.slice(0, 200);
      await requireIdle(env.DB);
      if (batch.length) await env.FILES.delete(batch.map(file => file.key));
      const after = await inventory(env);
      if (after.preservedHash !== before.preservedHash) throw new Error("PRESERVED_DATA_CHANGED");
      return json({ deletedFiles: batch.length, ...publicPlan(after) });
    }
    if (before.files.length) return json({ error: "FILES_REMAIN" }, 409);
    const statements = DEMO_TABLES.map(name => dbStatement(env.DB, name));
    statements.push(env.DB.prepare("DELETE FROM aigc_folders WHERE " + folderCondition).bind(...ROOT_FOLDERS));
    statements.push(env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('businessDataResetCompletedAt', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(new Date().toISOString(), new Date().toISOString()));
    // One atomic database transaction. Keep the schema, account rows and credentials intact.
    try { await guardedMutation(env.DB, maintenanceIdle, [], statements); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "STALE_RECORD") throw new Error("ACTIVE_WORK_REMAINS"); throw error; }
    const after = await inventory(env);
    if (after.preservedHash !== before.preservedHash || after.files.length || DEMO_TABLES.some(name => after.tables[name]) || after.tables.aigc_folders !== after.roots) throw new Error("CLEANUP_VERIFY_FAILED");
    return json({ completed: true, ...publicPlan(after) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const safe = ["SCHEMA_SCOPE_CHANGED", "BASE_FOLDERS_CHANGED", "EXTERNAL_STORAGE_NOT_IN_SCOPE", "OBJECT_SCOPE_TOO_LARGE", "INVALID_OBJECT_INVENTORY", "PRESERVED_DATA_CHANGED", "CLEANUP_VERIFY_FAILED", "ACTIVE_WORK_REMAINS"];
    return json({ error: safe.includes(code) ? code : "CLEANUP_FAILED" }, 503);
  }
}
function dbStatement(db: Database, name: typeof DEMO_TABLES[number]) { return db.prepare('DELETE FROM "' + name + '"'); }
