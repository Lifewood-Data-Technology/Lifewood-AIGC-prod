import { prepareAuditStatement } from "./audit-write";
import type { DatabaseStatement } from "./database";
import { businessUnlockedSql } from "./business-visibility";
import { assertBusinessAvailable, businessScopes } from "./business-deletion";
import { getAccount, requireCapability, workflowSubmissionDatabase, type PublicAccount } from "./backend";
import { guardedMutation } from "./mutation-guard";
import { PublicError } from "../lib/security-controls";
type Row = Record<string, unknown>;
type GuardedActor = PublicAccount & { managementRevision: number };
const pending = "status IN ('submitted','needs_supplement','rejected') AND (project_id IS NULL OR project_id = '')";
const requestAccess = (actor: PublicAccount) => actor.access === "project" ? "(pm_email = ? OR pm_email IS NULL)" : "sales_email = ?";
async function actorFor(email: string) {
  const actor = await getAccount(email);
  if (!actor || !["client", "project"].includes(actor.access)) throw new PublicError("Business access required.", 403);
  const authority = await workflowSubmissionDatabase()
    .prepare("SELECT management_revision FROM accounts WHERE email = ? AND access_group = ? AND status = 'active'")
    .bind(actor.email, actor.access)
    .first<{ management_revision: number }>();
  if (!authority) throw new PublicError("Business access required.", 403);
  return { ...actor, managementRevision: Number(authority.management_revision) } as GuardedActor;
}
export async function recycledBusiness(email: string) {
  const actor = await actorFor(email), db = workflowSubmissionDatabase();
  const clients = actor.access === "client" ? (await db.prepare(`SELECT id, name, revision, deleted_at, deleted_by FROM clients WHERE deleted_at IS NOT NULL AND owner_email = ? AND ${businessUnlockedSql("customer", "clients.id")} ORDER BY deleted_at DESC`).bind(actor.email).all<Row>()).results : [];
  const requests = (await db.prepare(`SELECT id, title AS name, recycle_revision AS revision, deleted_at, deleted_by, client_id FROM project_requests WHERE deleted_at IS NOT NULL AND ${businessUnlockedSql("customer", "project_requests.client_id")} AND ${businessUnlockedSql("project", "project_requests.project_id")} AND ${requestAccess(actor)} ORDER BY deleted_at DESC`).bind(actor.email).all<Row>()).results;
  return [...clients.map(row => ({...row, kind: "customer"})), ...requests.map(row => ({...row, kind: "request"}))];
}
export async function mutateBusiness(email: string, body: { operation: string; id: string; revision: number; children?: { id: string; revision: number; planVersion: number; recycleRevision: number; status: string }[]; reason?: string }) {
  const actor = await actorFor(email), db = workflowSubmissionDatabase();
  if (!body || typeof body.operation !== "string" || typeof body.id !== "string" || !Number.isSafeInteger(body.revision) || body.revision < 1 || (body.children !== undefined && !Array.isArray(body.children))) throw new PublicError("Refresh and select a valid record.",400);
  const kind = body.operation?.endsWith("customer") ? "customer" : "request";
  const restoring = body.operation?.startsWith("restore-");
  if (!["delete-customer", "delete-request", "restore-customer", "restore-request"].includes(body.operation)) throw new PublicError("Unsupported operation.");
  if (kind === "customer" && actor.access !== "client") throw new PublicError("Only the customer owner can delete or restore a customer.",403);
  await requireCapability(actor, actor.access === "project" ? "projects.manage" : kind === "customer" ? "customers.manage" : "requests.create");
  await assertBusinessAvailable(db, await businessScopes(db, kind === "customer" ? { customerId: body.id } : { requestId: body.id }));
  const table = kind === "customer" ? "clients" : "project_requests";
  const revisionColumn = kind === "customer" ? "revision" : "recycle_revision";
  const access = kind === "customer" ? "owner_email = ?" : requestAccess(actor);
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND ${access}`).bind(body.id, actor.email).first<Row>();
  if (!row) throw new PublicError("Record not found or access denied.",403);
  if (Number(row[revisionColumn]) !== body.revision || Boolean(row.deleted_at) !== restoring) throw new PublicError("Record changed or has unfinished work. Refresh and review before saving.",409,"STALE_RECORD");
  const now = new Date().toISOString(), batch = crypto.randomUUID();
  const statements: DatabaseStatement[] = [];
  let condition = `${businessUnlockedSql("customer", kind === "customer" ? "?" : "(SELECT client_id FROM project_requests WHERE id=?)")} AND EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND ${revisionColumn} = ? AND ${access} AND deleted_at IS ${restoring ? "NOT " : ""}NULL)`;
  const values: (string | number | null)[] = [body.id, body.id, body.revision, actor.email];
  if (kind === "request") {
    condition += ` AND EXISTS (SELECT 1 FROM clients WHERE id = ? AND owner_email = ? AND deleted_at IS NULL AND status <> 'Disabled') AND EXISTS (SELECT 1 FROM accounts WHERE email = ? AND access_group = 'client' AND status = 'active') AND (NULLIF(?, '') IS NULL OR EXISTS (SELECT 1 FROM accounts WHERE email = ? AND access_group = 'project' AND status = 'active')) AND EXISTS (SELECT 1 FROM project_requests WHERE id = ? AND revision = ? AND plan_version = ? AND ${pending})`;
    values.push(String(row.client_id), String(row.sales_email), String(row.sales_email), String(row.pm_email || ""), String(row.pm_email || ""), body.id, Number(row.revision), Number(row.plan_version || 0));
  } else if (!restoring) {
    const children = body.children;
    if (!Array.isArray(children) || children.length > 200 || children.some(child => !child || typeof child.id !== "string" || !Number.isSafeInteger(child.revision) || child.revision < 1 || !Number.isSafeInteger(child.planVersion) || child.planVersion < 0 || !Number.isSafeInteger(child.recycleRevision) || child.recycleRevision < 1 || !["submitted", "needs_supplement", "rejected"].includes(child.status)) || new Set(children.map(child => child.id)).size !== children.length) throw new PublicError("Review all pending projects before deleting the customer.");
    condition += ` AND NOT EXISTS (SELECT 1 FROM projects WHERE client_id = ?) AND NOT EXISTS (SELECT 1 FROM project_requests WHERE client_id = ? AND deleted_at IS NULL AND NOT (${pending})) AND (SELECT COUNT(*) FROM project_requests WHERE client_id = ? AND deleted_at IS NULL) = ?`;
    values.push(body.id,body.id,body.id,children.length);
    // Keep the parameter count bounded even for many pending projects.
    condition += " AND NOT EXISTS (SELECT 1 FROM json_each(?) snapshot WHERE NOT EXISTS (SELECT 1 FROM project_requests WHERE id = json_extract(snapshot.value,'$.id') AND client_id = ? AND revision = json_extract(snapshot.value,'$.revision') AND plan_version = json_extract(snapshot.value,'$.planVersion') AND recycle_revision = json_extract(snapshot.value,'$.recycleRevision') AND status = json_extract(snapshot.value,'$.status') AND deleted_at IS NULL))";
    values.push(JSON.stringify(children), body.id);
    statements.push(db.prepare("UPDATE project_requests SET deleted_at = ?, deleted_by = ?, deletion_batch_id = ?, recycle_revision = recycle_revision + 1, updated_at = ? WHERE client_id = ? AND deleted_at IS NULL").bind(now,actor.email,batch,now,body.id));
  } else {
    statements.push(db.prepare("UPDATE project_requests SET deleted_at = NULL, deleted_by = NULL, deletion_batch_id = NULL, recycle_revision = recycle_revision + 1, updated_at = ? WHERE client_id = ? AND deletion_batch_id = ? AND deleted_at IS NOT NULL").bind(now, body.id, String(row.deletion_batch_id)));
  }
  statements.push(db.prepare(`UPDATE ${table} SET deleted_at = ?, deleted_by = ?, deletion_batch_id = ?, ${revisionColumn} = ${revisionColumn} + 1, updated_at = ? WHERE id = ?`).bind(restoring ? null : now, restoring ? null : actor.email, restoring ? null : batch, now, body.id));
  const name = String(row.name || row.title), event = `business.${body.operation}`;
  statements.push(prepareAuditStatement(db, "INSERT INTO audit_logs (action,actor_email,subject,details,created_at) VALUES (?,?,?,?,?)").bind(event,actor.email,body.id,JSON.stringify({name, children: body.children?.map(child => child.id) || [], recoverable: true}),now));
  // Recipient identities come from the stored record, never from request input.
  const recipient = kind === "customer" ? "(a.email = ? OR a.access_group = 'project')" : "(a.email = ? OR (a.access_group = 'project' AND (a.email = ? OR ? IS NULL)))";
  const recipientValues = kind === "customer" ? [row.owner_email] : [row.sales_email, row.pm_email || null, row.pm_email || null];
  statements.push(db.prepare(`INSERT INTO notifications (id,recipient_email,type,title_zh,title_en,body_zh,body_en,target_type,target_id,is_read,created_at,actor_email,actor_name,actor_role,event_action)
    SELECT lower(hex(randomblob(16))),a.email,'project_request',?,?,?,?,'recycle',?,0,?,?,?,?,? FROM accounts a WHERE a.status = 'active' AND ${recipient}`).bind(
    restoring ? "记录已恢复" : "记录已移入回收站", restoring ? "Record restored" : "Record moved to recycle bin",
    `${actor.name} 已${restoring ? "恢复" : "删除"}“${name}”。${restoring ? "可继续处理。" : "原始记录保留，可在回收站恢复。"}`,
    `${actor.name} ${restoring ? "restored" : "deleted"} “${name}”. ${restoring ? "Work can continue." : "The original record is retained in the recycle bin."}`,
    body.id, now, actor.email, actor.name, actor.access, event, ...recipientValues));
  const capability = actor.access === "project" ? "projects.manage" : kind === "customer" ? "customers.manage" : "requests.create";
  condition += " AND EXISTS (SELECT 1 FROM accounts WHERE email = ? AND access_group = ? AND status = 'active' AND must_change_password = 0 AND management_revision = ?) AND NOT EXISTS (SELECT 1 FROM account_permissions WHERE account_email = ? AND permission_key = ? AND allowed = 0)";
  values.push(actor.email, actor.access, actor.managementRevision, actor.email, capability);
  await guardedMutation(db,condition,values,statements);
  return {ok:true};
}
