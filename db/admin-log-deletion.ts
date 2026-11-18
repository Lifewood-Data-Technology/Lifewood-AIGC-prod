import type {Database} from './database';
import {guardedMutation} from './mutation-guard';
import {prepareAuditStatement} from './audit-write';
import {readAuditSelection} from './audit-query';
import {readLoginLogSelection} from './admin-login-log';
import {PublicError} from '../lib/security-controls';
import {validateLogIds} from '../lib/log-query-controls';
import {LOG_DELETE_LIMIT,LOG_PREVIEW_TTL_MS,validLogSubmissionId,type LogKind,type LogDeletionCommand,type LogDeletionPreview,type LogDeletionReceipt} from '../lib/admin-log-deletion';

type Authority = {sql:string;values:(string|number|null)[]};
type Authorize = (kind:LogKind)=>Promise<Authority>;
type PreviewRow = {id:string;actor_email:string;target_kind:LogKind;ids_json:string;summary_json:string;record_count:number;expires_at:string;consumed_submission_id:string|null};
type ReceiptRow = {id:string;preview_id:string;actor_email:string;target_kind:LogKind;deleted_count:number};
const tableFor = (kind:LogKind)=>kind==='audit'?'audit_logs':'account_login_history';
const error = (message:string,code:string,status=409)=>new PublicError(message,status,code);

/** The callback supplies the same live account/config guard used by other managed mutations. */
export async function previewLogDeletion(db:Database,actorEmail:string,authorize:Authorize,command:Extract<LogDeletionCommand,{action:'preview'}>,now=Date.now()):Promise<LogDeletionPreview>{
  const authority=await authorize(command.kind);
  const params=new URLSearchParams(command.filters);
  // Transport/export parameters must never silently alter a destructive filter.
  if(['detailId','format','export','ids'].some(key=>params.has(key))) throw error('Invalid deletion filters.','INVALID_LOG_FILTER',400);
  let rows:{id:string|number}[];
  try { rows=command.kind==='audit'?await readAuditSelection(db,params,command.ids):await readLoginLogSelection(db,params,command.ids,now); }
  catch(cause){if(cause instanceof Error && /EXPORT_TOO_LARGE|10,000|10000|too large/i.test(cause.message))throw error('Narrow the filters to at most 10,000 records.','LOG_DELETE_TOO_LARGE',400);throw cause;}
  if(!rows.length)throw error('No matching log records remain. Refresh the list.','LOG_SELECTION_CHANGED');
  if(rows.length>LOG_DELETE_LIMIT)throw error('Narrow the filters to at most 10,000 records.','LOG_DELETE_TOO_LARGE',400);
  const ids=rows.map(row=>String(row.id));
  if(command.ids && (ids.length!==command.ids.length || command.ids.some(id=>!ids.includes(id))))throw error('Selected logs changed. Refresh before deleting.','LOG_SELECTION_CHANGED');
  const id=crypto.randomUUID(),expiresAt=new Date(now+LOG_PREVIEW_TTL_MS).toISOString();
  const filters=Object.fromEntries([...params.entries()].filter(([key,value])=>value&&!['page','pageSize','sort'].includes(key)));
  const summary=JSON.stringify({scope:command.ids?'selected':'filtered',filters,count:ids.length});
  await guardedMutation(db,authority.sql,authority.values,[
    db.prepare('DELETE FROM admin_log_deletion_previews WHERE expires_at < ? AND consumed_submission_id IS NULL').bind(new Date(now).toISOString()),
    db.prepare('INSERT INTO admin_log_deletion_previews (id,actor_email,target_kind,ids_json,summary_json,record_count,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id,actorEmail,command.kind,JSON.stringify(ids),summary,ids.length,expiresAt,new Date(now).toISOString()),
  ]);
  return {previewId:id,count:ids.length,expiresAt,summary};
}

export async function readLogDeletionReceipt(db:Database,actorEmail:string,authorize:Authorize,submissionId:string,kind:LogKind):Promise<LogDeletionReceipt|{submissionId:string;status:'not_found'}>{
  if(!validLogSubmissionId(submissionId))throw error('Invalid submission identifier.','INVALID_SUBMISSION',400);
  if(kind!=='audit'&&kind!=='login')throw error('Invalid log kind.','INVALID_LOG_KIND',400);
  // Authorize even an unknown submission; absence must not bypass revoked log permissions.
  await authorize(kind);
  const receipt=await db.prepare('SELECT id,preview_id,actor_email,target_kind,deleted_count FROM admin_log_deletion_receipts WHERE id = ?').bind(submissionId).first<ReceiptRow>();
  if(!receipt)return {submissionId,status:'not_found'};
  if(receipt.actor_email!==actorEmail||receipt.target_kind!==kind)throw error('This deletion receipt is outside the requested scope.','FORBIDDEN',403);
  return {submissionId,status:'completed',deletedCount:Number(receipt.deleted_count)};
}

export async function executeLogDeletion(db:Database,actorEmail:string,authorize:Authorize,command:Extract<LogDeletionCommand,{action:'execute'}>,now=Date.now()):Promise<LogDeletionReceipt>{
  if(command.confirmation!=='永久删除'||!validLogSubmissionId(command.submissionId)||!validLogSubmissionId(command.previewId))throw error('Confirm permanent deletion.','INVALID_CONFIRMATION',400);
  const prior=await db.prepare('SELECT id,preview_id,actor_email,target_kind,deleted_count FROM admin_log_deletion_receipts WHERE id = ?').bind(command.submissionId).first<ReceiptRow>();
  if(prior){
    if(prior.actor_email!==actorEmail||prior.preview_id!==command.previewId)throw error('Submission identifier is already bound to another deletion.','LOG_SUBMISSION_CONFLICT');
    await authorize(prior.target_kind);
    return {submissionId:prior.id,status:'completed',deletedCount:Number(prior.deleted_count)};
  }
  const preview=await db.prepare('SELECT * FROM admin_log_deletion_previews WHERE id = ? AND actor_email = ?').bind(command.previewId,actorEmail).first<PreviewRow>();
  if(!preview)throw error('Deletion preview is no longer available. Preview again.','LOG_PREVIEW_EXPIRED');
  if(!['audit','login'].includes(preview.target_kind))throw error('Invalid deletion preview.','INVALID_LOG_PREVIEW');
  const authority=await authorize(preview.target_kind);
  if(preview.consumed_submission_id)throw error('This preview has already been used.','LOG_SUBMISSION_CONFLICT');
  if(Date.parse(preview.expires_at)<=now)throw error('Deletion preview expired. Preview again.','LOG_PREVIEW_EXPIRED');
  let ids:string[],scope:'selected'|'filtered';
  try {
    const parsed:unknown=JSON.parse(preview.ids_json),summary:unknown=JSON.parse(preview.summary_json);
    if(!Array.isArray(parsed)||parsed.some(id=>typeof id!=='string')||parsed.length!==Number(preview.record_count)||!summary||typeof summary!=='object'||!('scope' in summary)||(summary.scope!=='selected'&&summary.scope!=='filtered'))throw Error('Invalid preview');
    ids=validateLogIds(parsed,preview.target_kind==='audit');scope=summary.scope;
  }catch{throw error('Invalid deletion preview.','INVALID_LOG_PREVIEW');}
  const table=tableFor(preview.target_kind),placeholders=ids.map(()=>'?').join(',');
  const currentTime=new Date(now).toISOString();
  const timeGuard=preview.target_kind==='login'?' AND occurred_at >= ?':'';
  const timeValues=preview.target_kind==='login'?[new Date(now-90*86400000).toISOString()]:[];
  const guard=`${authority.sql} AND EXISTS (SELECT 1 FROM admin_log_deletion_previews WHERE id = ? AND actor_email = ? AND target_kind = ? AND ids_json = ? AND summary_json = ? AND record_count = ? AND consumed_submission_id IS NULL AND expires_at > ?) AND (SELECT COUNT(*) FROM ${table} WHERE id IN (${placeholders})${timeGuard}) = ?`;
  // request_id is immutable after insertion. Shared metadata is removed only after the
  // guarded delete and only if no surviving audit references it, in the same transaction.
  const requestIds=preview.target_kind==='audit'?(await db.prepare(`SELECT DISTINCT request_id FROM audit_logs WHERE id IN (${placeholders}) AND request_id IS NOT NULL`).bind(...ids).all<{request_id:string}>()).results.map(row=>row.request_id):[];
  try{
    await guardedMutation(db,guard,[...authority.values,preview.id,actorEmail,preview.target_kind,preview.ids_json,preview.summary_json,ids.length,currentTime,...ids,...timeValues,ids.length],[
      db.prepare('INSERT INTO admin_log_deletion_receipts (id,preview_id,actor_email,target_kind,deleted_count,completed_at) VALUES (?,?,?,?,?,?)').bind(command.submissionId,preview.id,actorEmail,preview.target_kind,ids.length,currentTime),
      db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).bind(...ids),
      ...(requestIds.length?[db.prepare(`DELETE FROM audit_request_metadata WHERE request_id IN (${requestIds.map(()=>'?').join(',')}) AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE audit_logs.request_id = audit_request_metadata.request_id)`).bind(...requestIds)]:[]),
      // Erase the snapshot identifiers after completion. The minimal receipt is enough for retry verification.
      db.prepare('UPDATE admin_log_deletion_previews SET consumed_submission_id = ?, ids_json = ?, summary_json = ? WHERE id = ?').bind(command.submissionId,'[]','{}',preview.id),
      prepareAuditStatement(db,'INSERT INTO audit_logs (action,actor_email,subject,details,created_at) VALUES (?,?,?,?,?)').bind('logs.deleted',actorEmail,preview.target_kind,JSON.stringify({deletedCount:ids.length,scope,submissionId:command.submissionId}),currentTime),
    ]);
  }catch(cause){
    // A concurrent identical request may have committed first. Do not issue another deletion.
    const receipt=await db.prepare('SELECT id,preview_id,actor_email,target_kind,deleted_count FROM admin_log_deletion_receipts WHERE id = ?').bind(command.submissionId).first<ReceiptRow>();
    if(receipt?.actor_email===actorEmail&&receipt.preview_id===preview.id){await authorize(receipt.target_kind);return {submissionId:receipt.id,status:'completed',deletedCount:Number(receipt.deleted_count)};}
    if(receipt)throw error('Submission identifier is already bound to another deletion.','LOG_SUBMISSION_CONFLICT');
    const consumed=await db.prepare('SELECT consumed_submission_id FROM admin_log_deletion_previews WHERE id = ? AND actor_email = ?').bind(preview.id,actorEmail).first<{consumed_submission_id:string|null}>();
    if(consumed?.consumed_submission_id)throw error('This preview has already been used.','LOG_SUBMISSION_CONFLICT');
    if(cause instanceof PublicError&&cause.code==='STALE_RECORD')throw error('Authority or selected logs changed. Refresh and preview again.','LOG_SELECTION_CHANGED');
    throw cause;
  }
  return {submissionId:command.submissionId,status:'completed',deletedCount:ids.length};
}
