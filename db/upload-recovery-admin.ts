import {createHash,randomUUID} from 'node:crypto';
import type {Database} from './database';
import type {WasabiBucket} from '../runtime/wasabi';
import {parseDirectUpload,sessionAssets} from './direct-upload-service';
import {guardedMutation} from './mutation-guard';
import {prepareAuditStatement} from './audit-write';
import {PublicError} from '../lib/security-controls';
import {uploadClaimActive} from '../lib/direct-upload-state';
import {uploadRecoveryId,type UploadRecoveryReason,type UploadRecoveryReview} from '../lib/upload-recovery';

type Guard={sql:string;values:(string|number|null)[]};
type DirectRow={id:string;registration_id:string;actor_email:string;payload_json:string;assets_json:string;authority_json:string;scopes_json:string;request_hash:string;state:string;result_json:string|null;claim_id:string|null;lease_expires_at:string|null;expires_at:string;updated_at:string;cleaned_at:string|null};
type StageRow={id:string;actor_email:string;state:string;object_key:string;size_bytes:number;updated_at:string;expires_at:string;checksum_sha256:string;language_project_id:string;purpose:string};
type LegacyRow={id:string;owner:string|null;status:string;updated_at:string};
type Records={direct:DirectRow|null;stage:StageRow|null;legacy:LegacyRow|null};
type Head=Awaited<ReturnType<WasabiBucket['head']>>;
type Evidence={key:string;head:Head};
const failure=(code:string)=>new PublicError('Upload changed or cannot be safely abandoned. Check the record again.',409,code);
const iso=()=>new Date().toISOString();
const referenceTables=['aigc_storage_objects','project_files','project_request_documents','aigc_file_previews'] as const;

/** Exact-ID technical operations. Neither an administrator nor this module can submit a business file. */
export function createUploadRecoveryAdmin(deps:{db:Database;bucket:Pick<WasabiBucket,'head'|'findMultipart'|'abortMultipart'|'delete'|'assertDirectReady'>;resource:string;authorize:(operator:string)=>Promise<Guard>}) {
  const {db,bucket,resource}=deps;
  if(!resource)throw Error('UPLOAD_RECOVERY_RESOURCE_REQUIRED');
  function validate(id:string){if(!uploadRecoveryId.test(id))throw new PublicError('Enter a valid upload record ID.',400,'UPLOAD_RECOVERY_INVALID_ID');}
  async function select(id:string):Promise<Records>{
    const direct=await db.prepare('SELECT * FROM direct_upload_sessions WHERE id=?').bind(id).first<DirectRow>();
    const stage=await db.prepare('SELECT * FROM production_staged_files WHERE id=?').bind(id).first<StageRow>();
    const legacy=await db.prepare('SELECT u.*,a.email AS owner FROM upload_sessions u LEFT JOIN accounts a ON a.id=u.account_id WHERE u.id=?').bind(id).first<LegacyRow>();
    if(!direct&&!stage&&!legacy)throw new PublicError('Upload record not found.',404,'UPLOAD_RECOVERY_NOT_FOUND');
    return {direct,stage,legacy};
  }
  function references(keys:string[],id:string):Guard {
    const set=JSON.stringify(keys);
    return {sql:[...referenceTables.map(table=>`NOT EXISTS(SELECT 1 FROM ${table} WHERE object_key IN (SELECT value FROM json_each(?)))`),'NOT EXISTS(SELECT 1 FROM production_staged_files WHERE object_key IN (SELECT value FROM json_each(?)) AND (id<>? OR state IN (\'ready\',\'committed\')))'].join(' AND '),values:[...referenceTables.map(()=>set),set,id]};
  }
  async function satisfied(guard:Guard){return Boolean((await db.prepare(`SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END AS allowed`).bind(...guard.values).first<{allowed:number}>())?.allowed);}
  function directGuard(row:DirectRow):Guard {
    const columns=['id','registration_id','actor_email','payload_json','assets_json','authority_json','scopes_json','request_hash','state','result_json','claim_id','lease_expires_at','expires_at','updated_at','cleaned_at'] as const;
    return {sql:`EXISTS(SELECT 1 FROM direct_upload_sessions WHERE ${columns.map(key=>`COALESCE(${key},'')=?`).join(' AND ')})`,values:columns.map(key=>row[key]??'')};
  }
  function stageGuard(row:StageRow|null,id:string):Guard {
    if(!row)return {sql:'NOT EXISTS(SELECT 1 FROM production_staged_files WHERE id=?)',values:[id]};
    const columns=['id','actor_email','state','object_key','size_bytes','updated_at','expires_at','checksum_sha256','language_project_id','purpose'] as const;
    return {sql:`EXISTS(SELECT 1 FROM production_staged_files WHERE ${columns.map(key=>`${key}=?`).join(' AND ')})`,values:columns.map(key=>row[key])};
  }
  async function analyse(records:Records) {
    const {direct:row,stage,legacy}=records,evidence:Evidence[]=[],storage={objects:0,missing:0,copyReceipts:0};
    let reason:UploadRecoveryReason='READY',keys:string[]=[];
    if(legacy&&(row||stage))return {reason:'ID_COLLISION' as const,evidence,storage:null,keys};
    if(!row)return {reason:(legacy?'LEGACY_MAPPING_MISSING':'ORPHAN_MAPPING_MISSING') as UploadRecoveryReason,evidence,storage:null,keys};
    if(row.cleaned_at)return {reason:'CLEANED' as const,evidence,storage:null,keys};
    if(row.state==='ready'||row.result_json||stage&&['ready','committed'].includes(stage.state))return {reason:'REGISTERED' as const,evidence,storage:null,keys};
    if(!['created','uploading','verifying','cancelled','expired'].includes(row.state)||!Number.isFinite(Date.parse(row.expires_at)))return {reason:'INVALID_METADATA' as const,evidence,storage:null,keys};
    if(row.claim_id&&!Number.isFinite(Date.parse(row.lease_expires_at||'')))return {reason:'LEASE_UNKNOWN' as const,evidence,storage:null,keys};
    if(uploadClaimActive(row))return {reason:'PROCESSING' as const,evidence,storage:null,keys};
    if(['created','uploading','verifying'].includes(row.state)&&(!Number.isFinite(Date.parse(row.lease_expires_at||''))||Date.parse(row.lease_expires_at!)>Date.now()))return {reason:row.lease_expires_at&&Number.isFinite(Date.parse(row.lease_expires_at))?'RECENT_ACTIVITY' as const:'LEASE_UNKNOWN' as const,evidence,storage:null,keys};
    let assets:ReturnType<typeof sessionAssets>;
    try{
      const input=parseDirectUpload(JSON.parse(row.payload_json));
      if(input.id!==row.id||!uploadRecoveryId.test(row.registration_id))throw Error();
      assets=sessionAssets(row,input);
      if(stage&&(stage.actor_email!==row.actor_email||input.endpoint!=='/api/production-workspace'||stage.language_project_id!==input.fields.task||stage.purpose!==input.fields.purpose||Number(stage.size_bytes)!==input.file.size||!['uploading','abandoned','cleanup_claimed','expired'].includes(stage.state)))throw Error();
      keys=[...new Set(assets.flatMap(asset=>[asset.key,...(asset.destinations||[]).map(d=>d.key)]))];
      if(stage?.object_key&&!keys.includes(stage.object_key))return {reason:'COPY_UNCONFIRMED' as const,evidence,storage:null,keys};
    }catch{return {reason:'INVALID_METADATA' as const,evidence,storage:null,keys};}
    if(!await satisfied(references(keys,row.id)))return {reason:'REFERENCE_FOUND' as const,evidence,storage:null,keys};
    try{
      for(const asset of assets){
        const objects=[{key:asset.key,confirmed:true},...(asset.destinations||[])];
        for(const object of objects){
          const head=await bucket.head(object.key);evidence.push({key:object.key,head});
          if(head){storage.objects++;if(head.uploadOwner!==row.id||head.size!==asset.size)reason='OWNERSHIP_MISMATCH';}else storage.missing++;
          if('copyProtocol' in object&&object.copyProtocol==='multipart-receipt-v1'&&object.handle)storage.copyReceipts++;
          if(!object.confirmed&&!head&&(!('copyProtocol' in object)||object.copyProtocol!=='multipart-receipt-v1'||!object.handle)&&reason==='READY')reason='COPY_UNCONFIRMED';
        }
      }
    }catch{return {reason:'STORAGE_UNAVAILABLE' as const,evidence,storage:null,keys};}
    return {reason,evidence,storage,keys};
  }
  function digest(operator:string,checkedAt:string,records:Records,evidence:Evidence[]){return createHash('sha256').update(JSON.stringify({protocol:1,resource,operator,checkedAt,records,evidence})).digest('hex');}
  function response(id:string,operator:string,checkedAt:string,records:Records,analysis:Awaited<ReturnType<typeof analyse>>):UploadRecoveryReview {
    const {direct:row,stage,legacy}=records;
    return {id,kind:row?'direct':legacy?'legacy':'staged',owner:row?.actor_email||legacy?.owner||stage?.actor_email||'',state:row?.state||legacy?.status||stage?.state||'',updatedAt:row?.updated_at||legacy?.updated_at||stage?.updated_at||'',expiresAt:row?.expires_at||stage?.expires_at||null,leaseExpiresAt:row?.lease_expires_at||null,checkedAt,review:digest(operator,checkedAt,records,analysis.evidence),reason:analysis.reason,canAbandon:analysis.reason==='READY',storage:analysis.storage};
  }
  async function review(operator:string,id:string) {
    validate(id);await deps.authorize(operator);
    const records=await select(id),analysis=await analyse(records),authority=await deps.authorize(operator);
    if(!await satisfied(authority))throw failure('UPLOAD_RECOVERY_AUTHORITY_CHANGED');
    return response(id,operator,iso(),records,analysis);
  }
  async function abandon(operator:string,command:{id:string;review:string;checkedAt:string;confirmation:string}) {
    validate(command.id);
    if(command.confirmation!=='ABANDON'||!/^[a-f0-9]{64}$/.test(command.review)||!Number.isFinite(Date.parse(command.checkedAt))||Date.parse(command.checkedAt)>Date.now()||Date.now()-Date.parse(command.checkedAt)>300000)throw failure('UPLOAD_RECOVERY_REVIEW_EXPIRED');
    const authority=await deps.authorize(operator),records=await select(command.id),analysis=await analyse(records),row=records.direct;
    if(digest(operator,command.checkedAt,records,analysis.evidence)!==command.review)throw failure('UPLOAD_RECOVERY_REVIEW_CHANGED');
    if(analysis.reason!=='READY'||!row)throw failure('UPLOAD_RECOVERY_PROTECTED');
    await bucket.assertDirectReady();
    const original=directGuard(row),staged=stageGuard(records.stage,row.id),refs=references(analysis.keys,row.id),token=randomUUID(),now=iso();
    await guardedMutation(db,`${authority.sql} AND ${original.sql} AND ${staged.sql} AND ${refs.sql}`,[...authority.values,...original.values,...staged.values,...refs.values],[
      db.prepare("UPDATE direct_upload_sessions SET state='cancelled',claim_id=?,lease_expires_at=?,updated_at=? WHERE id=?").bind(token,new Date(Date.now()+600000).toISOString(),now,row.id),
      ...(records.stage?[db.prepare("UPDATE production_staged_files SET state='cleanup_claimed',updated_at=? WHERE id=?").bind(now,row.id)]:[]),
      prepareAuditStatement(db,'INSERT INTO audit_logs (action,actor_email,subject,details,created_at) VALUES (?,?,?,?,?)').bind('admin.upload.abandon.started',operator,row.id,JSON.stringify({owner:row.actor_email,review:command.review,operationId:token}),now),
    ]);
    const active:Guard={sql:`${authority.sql} AND EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND registration_id=? AND actor_email=? AND state='cancelled' AND cleaned_at IS NULL AND claim_id=? AND lease_expires_at>?) AND ${refs.sql} AND NOT EXISTS(SELECT 1 FROM production_staged_files WHERE id=? AND state IN ('ready','committed'))`,values:[...authority.values,row.id,row.registration_id,row.actor_email,token,'',...refs.values,row.id]};
    const assertCurrent=async()=>{active.values[authority.values.length+4]=iso();if(!await satisfied(active))throw failure('UPLOAD_RECOVERY_CHANGED_DURING_CLEANUP');};
    const abort=async(key:string,handle:string)=>{await assertCurrent();try{await bucket.abortMultipart(key,handle);}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error;}};
    try{
      const assets=sessionAssets(row,parseDirectUpload(JSON.parse(row.payload_json)));
      // Abort every exact persisted operation before deleting anything. No prefix scan or body read.
      for(const asset of assets){
        if(asset.handle)await abort(asset.key,asset.handle);
        else {await assertCurrent();for(const handle of await bucket.findMultipart(asset.key))await abort(asset.key,handle);}
        for(const dest of asset.destinations||[])if(dest.copyProtocol==='multipart-receipt-v1'&&dest.handle)await abort(dest.key,dest.handle);
      }
      for(const asset of assets)for(const key of [asset.key,...(asset.destinations||[]).map(dest=>dest.key)]){
        await assertCurrent();const current=await bucket.head(key),prior=analysis.evidence.find(e=>e.key===key)?.head;
        if(current&&(current.uploadOwner!==row.id||current.size!==asset.size||prior&&current.etag!==prior.etag))throw failure('UPLOAD_RECOVERY_STORAGE_CHANGED');
        await assertCurrent();if(current)await bucket.delete(key);
        if(await bucket.head(key))throw failure('UPLOAD_RECOVERY_CLEANUP_UNCONFIRMED');
      }
      await assertCurrent();
      const finished=iso();await guardedMutation(db,active.sql,active.values,[
        ...(records.stage?[db.prepare("UPDATE production_staged_files SET state='expired',updated_at=? WHERE id=? AND state='cleanup_claimed'").bind(finished,row.id)]:[]),
        db.prepare("UPDATE direct_upload_sessions SET state='expired',cleaned_at=?,claim_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND claim_id=?").bind(finished,finished,row.id,token),
        prepareAuditStatement(db,'INSERT INTO audit_logs (action,actor_email,subject,details,created_at) VALUES (?,?,?,?,?)').bind('admin.upload.abandon.completed',operator,row.id,JSON.stringify({owner:row.actor_email,operationId:token}),finished),
      ]);
      return {id:row.id,status:'cleaned' as const};
    }catch(error){
      console.warn({event:'admin.upload.cleanup.unconfirmed',sessionId:row.id,reason:error instanceof PublicError?error.code:'STORAGE_OR_DATABASE_ERROR'});
      throw error instanceof PublicError?error:new PublicError('Cleanup is unconfirmed. Check this record before retrying.',503,'UPLOAD_RECOVERY_CLEANUP_UNCONFIRMED');
    }finally{
      // Retain cancelled/cleanup_claimed metadata on failure. An expired worker cannot register later.
      await db.prepare('UPDATE direct_upload_sessions SET claim_id=NULL,lease_expires_at=NULL WHERE id=? AND claim_id=?').bind(row.id,token).run();
    }
  }
  return {review,abandon};
}
