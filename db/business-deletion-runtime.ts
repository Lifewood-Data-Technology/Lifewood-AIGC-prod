import { getAccount, mutationAuthority, requireCapability, workflowSubmissionDatabase } from "./backend";
import { customerMaintenanceScope } from "./customer-access";
import { createBusinessDeletionService, type DeletionTarget, type PermanentObjectStore, type UploadCancellation, type UploadCancelOptions } from "./business-deletion";
import { PublicError } from "../lib/security-controls";

/** The storage implementation is injected only after environment-specific purge verification. */
export function businessDeletionRuntime(storage: PermanentObjectStore) {
  const db = workflowSubmissionDatabase();
  return createBusinessDeletionService({ db, storage, async authority(email: string, target: DeletionTarget) {
    const actor = await getAccount(email);
    if (!actor || !["client", "project"].includes(actor.access)) throw new PublicError("Business access required.", 403);
    const capability = target.kind === "customer" ? "customers.manage" : "projects.manage";
    if (target.kind === "project" && actor.access !== "project") throw new PublicError("Project management access required.", 403);
    await requireCapability(actor, capability);
    const account = await db.prepare("SELECT id,management_revision FROM accounts WHERE email=? AND access_group=? AND status='active' AND must_change_password=0").bind(actor.email, actor.access).first<{ id: string; management_revision: number }>();
    if (!account) throw new PublicError("Business access required.", 403);
    const authorized = target.kind === "customer" ? customerMaintenanceScope(actor, "c") : { sql: "c.project_owner_email=?", values: [actor.email] };
    const table = target.kind === "customer" ? "clients" : "projects";
    const row = await db.prepare(`SELECT id FROM ${table} c WHERE c.id=? AND (${authorized.sql})`).bind(target.id, ...authorized.values).first();
    // A completed target no longer exists. Exact account identity and management revision
    // keep receipt/recovery access private without pretending the target still exists.
    const receipt = !row ? await db.prepare("SELECT id FROM business_deletion_jobs WHERE target_kind=? AND target_id=? AND actor_email=? AND actor_account_id=? AND actor_revision=? AND state='complete'").bind(target.kind, target.id, actor.email, account.id, account.management_revision).first() : null;
    if (!row && !receipt) throw new PublicError("Record not found or access denied.", 403);
    const condition = "EXISTS(SELECT 1 FROM accounts WHERE email=? AND id=? AND access_group=? AND management_revision=? AND status='active' AND must_change_password=0) AND NOT EXISTS(SELECT 1 FROM account_permissions WHERE account_email=? AND permission_key=? AND allowed=0)";
    // The shared commit guard also catches a role-level capability change in the admin directory,
    // which does not bump the account revision.
    const capabilityGuard = await mutationAuthority(db, actor, capability);
    return { actor: { email: actor.email, accountId: account.id, revision: account.management_revision, access: actor.access }, condition: `${condition} AND ${capabilityGuard.sql}${row ? ` AND EXISTS(SELECT 1 FROM ${table} c WHERE c.id=? AND (${authorized.sql}))` : ""}`, values: [actor.email, account.id, actor.access, account.management_revision, actor.email, capability, ...capabilityGuard.values, ...(row ? [target.id, ...authorized.values] : [])] };
  }, uploads: {
    // Loaded on demand: proxy-mode environments refuse with DIRECT_TRANSFER_DISABLED, never a fallback.
    // The options carry the reviewed idle state into the upload service's atomic claim; dropping them
    // would let an upload that resumed after the review be cancelled.
    async cancel(uploader: string, id: string, options?: UploadCancelOptions) { const { directUploads } = await import("./direct-upload"); return directUploads().cancel(uploader, id, options); },
  } satisfies UploadCancellation });
}

export const unavailablePermanentStore: PermanentObjectStore = {
  async assertReady() { throw new PublicError("Permanent deletion is unavailable until isolated storage validation is completed.", 503, "PERMANENT_DELETION_NOT_VERIFIED"); },
  async purge() { throw new PublicError("Permanent deletion is unavailable until isolated storage validation is completed.", 503, "PERMANENT_DELETION_NOT_VERIFIED"); },
};
