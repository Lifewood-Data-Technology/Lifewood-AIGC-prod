import { createHash } from "node:crypto";
import type { Database } from "./database";
import type { createDirectUploadService } from "./direct-upload-service";
import { uploadClaimActive } from '../lib/direct-upload-state';

type Request = { actor: string; ids: string[]; resource: string };
type Row = {
  id: string; actor_email: string; state: string; registration_id: string;
  request_hash: string; payload_json: string; assets_json: string;
  updated_at: string; expires_at: string; lease_expires_at: string | null;
  claim_id: string | null; cleaned_at: string | null; result_json: string | null;
  staged_state: string | null; staged_updated_at: string | null;
};
type Cancellation = Pick<ReturnType<typeof createDirectUploadService>, "cancel"> & Partial<Pick<ReturnType<typeof createDirectUploadService>, 'complete'>>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Operator-only recovery: inspect exact owner/IDs, then explicitly resume or abandon a reviewed reservation.
 * No prefix scan, direct SQL state mutation, file-body read or formal workflow submission.
 */
export function createDirectUploadRecovery(db: Database, service: Cancellation, resource: string) {
  function validate(request: Request) {
    if (!resource || request.resource !== resource) throw Error("RECOVERY_RESOURCE_MISMATCH");
    if (!request.actor || request.actor.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(request.actor)) throw Error("RECOVERY_INVALID_OWNER");
    if (!Array.isArray(request.ids) || request.ids.length < 1 || request.ids.length > 10 ||
      request.ids.some(id => !uuid.test(id)) || new Set(request.ids).size !== request.ids.length) throw Error("RECOVERY_INVALID_IDS");
    return [...request.ids].sort();
  }
  async function select(request: Request) {
    const rows: Row[] = [];
    // All requested records must belong to the reviewed owner before any cancellation begins.
    for (const id of validate(request)) {
      const row = await db.prepare("SELECT d.*,s.state AS staged_state,s.updated_at AS staged_updated_at FROM direct_upload_sessions d LEFT JOIN production_staged_files s ON s.id=d.id AND s.actor_email=d.actor_email WHERE d.id=? AND d.actor_email=?").bind(id, request.actor).first<Row>();
      if (!row) throw Error("RECOVERY_UPLOAD_UNAVAILABLE");
      rows.push(row);
    }
    return rows;
  }
  function blockingReason(row: Row, now: number) {
    if (row.cleaned_at) return "ALREADY_CLEANED";
    if (["ready", "committed"].includes(row.staged_state || "") || row.state === "ready" || row.result_json) return "COMPLETED_UPLOAD";
    if (!["created", "uploading"].includes(row.state)) return "NOT_CANCELLABLE_STATE";
    if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now) return "EXPIRED_UPLOAD";
    if (row.claim_id) return "CLAIM_PRESENT";
    if (!row.lease_expires_at || !Number.isFinite(Date.parse(row.lease_expires_at)) || Date.parse(row.lease_expires_at) > now) return "LEASE_NOT_EXPIRED";
    return null;
  }
  function snapshot(request: Request, rows: Row[]) {
    // Hash persisted identities and ownership metadata, never expose payloads, keys or signatures.
    return createHash("sha256").update(JSON.stringify({ resource, actor: request.actor, rows })).digest("hex");
  }
  async function review(request: Request) {
    const rows = await select(request), now = Date.now();
    return {
      resource, checkedAt: new Date(now).toISOString(), review: snapshot(request, rows),
      uploads: rows.map(row => ({
        id: row.id, state: row.state, updatedAt: row.updated_at,
        leaseExpiresAt: row.lease_expires_at, expiresAt: row.expires_at,
        hasClaim: Boolean(row.claim_id), cleanedAt: row.cleaned_at,
        stagedState: row.staged_state, blocked: blockingReason(row, now),
        resumable:!row.cleaned_at&&['created','uploading','verifying'].includes(row.state)&&Date.parse(row.expires_at)>now&&!uploadClaimActive(row,now),
      })),
    };
  }
  async function cancel(request: Request & { review: string }) {
    const rows = await select(request);
    if (!/^[a-f0-9]{64}$/.test(request.review) || snapshot(request, rows) !== request.review) throw Error("RECOVERY_REVIEW_CHANGED");
    if (rows.some(row => blockingReason(row, Date.now()))) throw Error("RECOVERY_UPLOAD_NOT_CANCELLABLE");
    const cancelled: string[] = [];
    for (const row of rows) {
      // Detect renewal by another process between items. The service also atomically claims
      // the original reservation and refuses a completed upload or a concurrent claim.
      const [current] = await select({ ...request, ids: [row.id] });
      if (snapshot(request, [current]) !== snapshot(request, [row]) || blockingReason(current, Date.now())) {
        return { cancelled, stopped: { id: row.id, code: "RECOVERY_REVIEW_CHANGED" } };
      }
      try {
        await service.cancel(request.actor, row.id);
        cancelled.push(row.id);
        console.info({ event: "direct-upload.recovery.cancelled", sessionId: row.id });
      } catch {
        // Cancellation can change provider state before returning an error. Preserve the
        // exact IDs and stop; no automatic retry or unscoped cleanup is safe here.
        return { cancelled, stopped: { id: row.id, code: "RECOVERY_CANCEL_UNCONFIRMED" } };
      }
    }
    return { cancelled, stopped: null };
  }
  async function resume(request:Request&{review:string}) {
    const rows=await select(request);
    if(!/^[a-f0-9]{64}$/.test(request.review)||snapshot(request,rows)!==request.review)throw Error('RECOVERY_REVIEW_CHANGED');
    if(!service.complete)throw Error('RECOVERY_RESUME_UNAVAILABLE');
    if(rows.some(row=>row.cleaned_at||!['created','uploading','verifying'].includes(row.state)||!(Date.parse(row.expires_at)>Date.now())||uploadClaimActive(row)))throw Error('RECOVERY_UPLOAD_NOT_RESUMABLE');
    const resumed:{id:string;state:string}[]=[];
    for(const row of rows){
      const [current]=await select({...request,ids:[row.id]});
      if(snapshot(request,[current])!==snapshot(request,[row]))return {resumed,stopped:{id:row.id,code:'RECOVERY_REVIEW_CHANGED'}};
      try{
        const result=await service.complete(request.actor,row.id,{sql:'EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND registration_id=? AND assets_json=? AND state=? AND updated_at=?)',values:[row.id,row.registration_id,row.assets_json,row.state,row.updated_at]},{source:'operator'});
        resumed.push({id:row.id,state:result.state});
        console.info({event:'direct-upload.recovery.resumed',sessionId:row.id,state:result.state});
      }catch{return {resumed,stopped:{id:row.id,code:'RECOVERY_RESUME_UNCONFIRMED'}};}
    }
    return {resumed,stopped:null};
  }
  return { review, cancel, resume };
}
