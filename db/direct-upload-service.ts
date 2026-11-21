import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./database";
import type { UploadExecution } from "./upload-execution";
import { guardedMutation } from "./mutation-guard";
import { consumeRateLimit, PublicError } from "../lib/security-controls";
import {UploadAdmissionError} from '../lib/upload-admission-error';
import { readUploadSettings } from "../lib/upload-settings";
import {directUploadMaxBytes, requirementUploadMaxBytes, previewUploadMaxBytes} from "../lib/upload-policy";
import { directPartLength, directPartSize, type DirectUploadFile, type DirectUploadInput, type RecoverableDirectUpload } from "../lib/direct-upload-contract";
import { storedUploadFile } from "../runtime/verified-upload";
import { storedMultipartIntegrity } from "../runtime/direct-upload-integrity";
import type { WasabiBucket } from "../runtime/wasabi";
import { uploadClaimActive, uploadClaimInterrupted } from '../lib/direct-upload-state';
import type {UploadRecordSummary} from '../lib/upload-recovery';

type Destination = {key:string;confirmed:boolean;copyProtocol?:'multipart-receipt-v1';handle?:string};
type Asset = DirectUploadFile & { slot: string; key: string; handle: string; etag?: string; parts: Record<string, string>; destinations?:Destination[] };
type Session = { id:string; registration_id:string; actor_email:string; request_hash:string; payload_json:string; assets_json:string; authority_json:string; state:string; result_json:string|null; claim_id:string|null; lease_expires_at:string|null; expires_at:string; scopes_json:string; updated_at:string };
type Guard = {sql:string;values:(string|number|null)[]};
/** Background completion yields to foreground uploads at safe boundaries; see the finalizer. */
export const backgroundYieldCode='UPLOAD_BACKGROUND_YIELDED';
export const backgroundYieldError=()=>new PublicError('Background completion yielded to a foreground upload.',409,backgroundYieldCode);
export type CompletionOptions={source?:'user'|'background'|'operator';
  // Aborted (with backgroundYieldError) when a foreground upload starts; checked between steps and passed to the copy.
  signal?:AbortSignal;
  // Evaluated inside the registration transaction, so a foreground upload starting after the last check still wins.
  foregroundGuard?:()=>Guard};
export type DirectUploadMetric={sessionId:string;phase:'reserve'|'sign'|'verify'|'promote'|'register';durationMs:number;bytes?:number;rssBytes:number};
const preparedGuard=(value:object):Guard|undefined=>'guard' in value?value.guard as Guard:undefined;
function registrationIdentity(id:string,kind:string){const h=createHash('sha256').update(`lifewood-direct:${id}:${kind}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
type Dispatch = (actor:string,input:DirectUploadInput,file:File,thumbnail:File|undefined,execution:UploadExecution)=>Promise<object>;
const retention = 7 * 86400000;
// Derived JPEGs have their own bounded pool. Neither hidden reservations nor
// slow preview verification may take a normal file's upload capacity.
function uploadPool(input:DirectUploadInput){
  const automatic=input.fields.scope==='automatic-preview',settings=readUploadSettings();
  return {automatic,sql:`COALESCE(json_extract(payload_json,'$.fields.scope'),'') ${automatic?'=':'<>'} 'automatic-preview'`,
    accountConcurrency:automatic?1:settings.accountConcurrency,siteConcurrency:automatic?2:settings.siteConcurrency,
    maxRetained:automatic?32:200,maxBytes:automatic?64*1024*1024:2147483648,retention:automatic?15*60000:retention};
}
const iso = () => new Date().toISOString();
const denied = () => new PublicError("Upload session unavailable.",404,"UPLOAD_UNAVAILABLE");
export function parseDirectUpload(value: unknown): DirectUploadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('Invalid upload request.');
  const v = value as Record<string,unknown>;
  if (Object.keys(v).some(k=>!['id','endpoint','fields','file','thumbnail'].includes(k)) || typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.id) || !['/api/files','/api/request-documents','/api/production-workspace'].includes(String(v.endpoint))) throw new PublicError('Invalid upload identity.');
  const endpoint = v.endpoint as DirectUploadInput['endpoint'];
  const allowed = endpoint === '/api/files' ? ['languageProjectId','directory','folderId','logicalFileId','scope','assetName','collectionId','relationType','thumbnailForVersionId','forceThumbnail','sourceAssetIds','parentUploadId'] : endpoint === '/api/request-documents' ? ['requestId'] : ['task','purpose','category','id'];
  if (!v.fields || typeof v.fields !== 'object' || Array.isArray(v.fields) || Object.entries(v.fields).some(([k,x])=>!allowed.includes(k)||typeof x!=='string'||x.length>12000)) throw new PublicError('Invalid upload destination.');
  const metadata = (raw:unknown,limit:number):DirectUploadFile => {
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new PublicError('Invalid file metadata.');
    const f=raw as Record<string,unknown>;
    if (Object.keys(f).some(k=>!['name','type','size','sha256'].includes(k)) || typeof f.name!=='string' || !f.name.trim() || f.name.length>255 || Array.from(f.name).some(c=>c.charCodeAt(0)<32||c==='/'||c==='\\') || typeof f.type!=='string' || f.type.length>255 || !Number.isSafeInteger(f.size) || Number(f.size)<1 || Number(f.size)>limit || typeof f.sha256!=='string' || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new PublicError('Invalid file metadata.',400,'INVALID_UPLOAD_METADATA');
    return {name:f.name,type:f.type,size:Number(f.size),sha256:f.sha256};
  };
  const fields = v.fields as Record<string,string>;
  if(v.thumbnail&&(endpoint!=='/api/files'||fields.scope!=='library'||fields.thumbnailForVersionId))throw new PublicError('Unexpected upload thumbnail.');
  if (endpoint==='/api/production-workspace' && fields.id && fields.id!==v.id) throw new PublicError('Upload identity mismatch.',409);
  const max = endpoint==='/api/request-documents'?requirementUploadMaxBytes:fields.thumbnailForVersionId?previewUploadMaxBytes:directUploadMaxBytes;
  return {id:v.id,endpoint,fields,file:metadata(v.file,max),...(v.thumbnail?{thumbnail:metadata(v.thumbnail,previewUploadMaxBytes)}:{})};
}

/** Metadata objects are used only by prepareOnly, which must finish before any body read/write. */
function metadataFile(info:DirectUploadFile) { const f=new File([],info.name,{type:info.type});Object.defineProperty(f,'size',{value:info.size});return f; }
export function sessionAssets(row:Pick<Session,'id'|'assets_json'>,input:DirectUploadInput):Asset[]{
  const value:unknown=JSON.parse(row.assets_json),expected=[{slot:'file',...input.file},...(input.thumbnail?[{slot:'thumbnail',...input.thumbnail}]:[])];
  if(!Array.isArray(value)||value.length!==expected.length)throw Error('Invalid persisted upload assets');
  return expected.map((info,index)=>{
    const asset=value[index] as Asset|undefined;
    if(!asset||asset.slot!==info.slot||asset.key!==`direct-upload-temporary/${row.id}/${info.slot}`||asset.name!==info.name||asset.type!==info.type||asset.size!==info.size||asset.sha256!==info.sha256||typeof asset.handle!=='string'||asset.handle.length>2048||!asset.parts||typeof asset.parts!=='object'||Array.isArray(asset.parts)||Object.entries(asset.parts).some(([number,digest])=>!Number.isInteger(Number(number))||Number(number)<1||Number(number)>Math.ceil(info.size/directPartSize)||typeof digest!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(digest))||asset.etag!==undefined&&typeof asset.etag!=='string'||asset.destinations!==undefined&&(!Array.isArray(asset.destinations)||asset.destinations.length>8||asset.destinations.some(d=>!d||typeof d.key!=='string'||!d.key||d.key.startsWith('/')||d.key.split('/').some(s=>s==='..')||d.key.includes('\0')||typeof d.confirmed!=='boolean')))throw Error('Invalid persisted upload ownership');
    if(asset.destinations?.some(destination=>destination.copyProtocol!==undefined&&destination.copyProtocol!=='multipart-receipt-v1'||destination.handle!==undefined&&(typeof destination.handle!=='string'||!destination.handle||destination.handle.length>2048||destination.copyProtocol!=='multipart-receipt-v1')))throw Error('Invalid persisted copy receipt');
    return asset;
  });
}
export function createDirectUploadService(deps:{db:Database;bucket:WasabiBucket;dispatch:Dispatch;scopes:(input:DirectUploadInput)=>Promise<string[]>;previewAuthority?:(actor:string,input:DirectUploadInput)=>Promise<Guard|null>;authorizeList?:(actor:string,taskId:string,purpose:string)=>Promise<void>;beforeCreate?:(actor:string,input:DirectUploadInput)=>Promise<void>;observe?:(metric:DirectUploadMetric)=>void}) {
  const {db,bucket}=deps;
  async function storageControl<T>(id:string,phase:'sign'|'status',operation:()=>Promise<T>):Promise<T>{
    try{return await operation();}catch(error){
      const name=error instanceof Error?error.name:'Unknown';
      const reason=['AbortError','TimeoutError','RequestTimeout','AccessDenied','NoSuchUpload'].includes(name)?name:'UNCLASSIFIED';
      console.warn({event:'direct-upload.storage-control.unconfirmed',sessionId:id,phase,reason});
      if(['AbortError','TimeoutError','RequestTimeout'].includes(name))throw new PublicError('Wasabi upload setup or status check timed out. The original upload is retained; check it or select the original file to resume.',503,'DIRECT_STORAGE_CONTROL_TIMEOUT');
      throw error;
    }
  }
  const observe=(sessionId:string,phase:DirectUploadMetric['phase'],started:number,bytes?:number)=>{try{deps.observe?.({sessionId,phase,durationMs:Math.round(performance.now()-started),...(bytes!==undefined?{bytes}:{}),rssBytes:process.memoryUsage().rss});}catch{/* Diagnostic consumers cannot change a committed result. */}};
  async function load(actor:string,id:string,authorize=true) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw denied();
    const row=await db.prepare('SELECT * FROM direct_upload_sessions WHERE id=? AND actor_email=? AND expires_at>?').bind(id,actor,iso()).first<Session>();
    if (!row || ['cancelled','expired'].includes(row.state)) throw denied();
    const input=parseDirectUpload(JSON.parse(row.payload_json));
    if(authorize)await deps.dispatch(actor,input,metadataFile(input.file),input.thumbnail?metadataFile(input.thumbnail):undefined,{prepareOnly:true});
    const authority=JSON.parse(row.authority_json) as Guard|null;
    if(authorize&&row.state!=='ready'&&authority){const valid=await db.prepare(`SELECT CASE WHEN (${authority.sql}) THEN 1 ELSE 0 END AS allowed`).bind(...authority.values).first<{allowed:number}>();if(!valid?.allowed)throw new PublicError('The upload destination changed. Review it before starting a new upload.',409,'STALE_UPLOAD_DESTINATION');}
    return {row,input,assets:sessionAssets(row,input)};
  }
  const dto=(row:Session)=>({id:row.id,state:row.state,busy:uploadClaimActive(row),interrupted:uploadClaimInterrupted(row),partSize:directPartSize,...(row.state==='ready'&&row.result_json?{result:JSON.parse(row.result_json)}:{})});
  async function list(actor:string,taskId:string,purpose:string,category='') {
    if(!taskId||taskId.length>100||!['materials','daily','checkpoint','final','archive'].includes(purpose)||category.length>64||category&&!/^[a-z0-9._-]+$/.test(category))throw new PublicError('Invalid upload selection.');
    if(!deps.authorizeList)throw new PublicError('Upload recovery is unavailable.',403);
    // Authorised for the purpose being listed (a Deseret archive stays open through review); only that purpose is returned.
    await deps.authorizeList(actor,taskId,purpose);
    const rows=(await db.prepare("SELECT * FROM direct_upload_sessions WHERE actor_email=? AND cleaned_at IS NULL AND state IN ('created','uploading','verifying','cancelled','expired') AND json_extract(payload_json,'$.endpoint')='/api/production-workspace' AND json_extract(payload_json,'$.fields.task')=? AND json_extract(payload_json,'$.fields.purpose')=?"+(category?" AND json_extract(payload_json,'$.fields.category')=?":"")+" ORDER BY created_at,id LIMIT 201").bind(actor,taskId,purpose,...(category?[category]:[])).all<Session>()).results;
    if(rows.length>200)throw new PublicError('Too many unfinished uploads. Ask an operator to review them.',409);
    const uploads:RecoverableDirectUpload[]=[];
    for(const row of rows){
      const input=parseDirectUpload(JSON.parse(row.payload_json));
      if(input.endpoint!=='/api/production-workspace'||input.fields.task!==taskId||input.fields.purpose!==purpose||category&&input.fields.category!==category)continue;
      const busy=uploadClaimActive(row),interrupted=uploadClaimInterrupted(row),expired=!(Date.parse(row.expires_at)>Date.now())||row.state==='expired',active=['created','uploading','verifying'].includes(row.state);
      uploads.push({input,state:row.state,busy,interrupted,expired,canCheck:active&&!expired&&!busy,canCancel:active&&!expired&&!busy&&!interrupted&&!sessionAssets(row,input).some(asset=>asset.destinations?.some(destination=>!destination.confirmed)),updatedAt:row.updated_at,expiresAt:row.expires_at});
    }
    // Return only the owner's original metadata, never storage handles or authority guards.
    return {uploads};
  }
  async function uploadContext(input:DirectUploadInput) {
    const task=input.fields.task||input.fields.languageProjectId;
    if(task){const row=await db.prepare('SELECT p.name AS project_name,v.name AS video_name,l.language,l.language_code FROM language_projects l JOIN projects p ON p.id=l.project_id LEFT JOIN project_videos v ON v.id=l.video_id WHERE l.id=?').bind(task).first<{project_name:string;video_name:string|null;language:string;language_code:string|null}>();if(row)return {project:row.project_name,task:row.video_name||'',language:row.language,languageCode:row.language_code||''};}
    if(input.fields.requestId){const row=await db.prepare('SELECT p.name AS project_name,r.title FROM project_requests r LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=?').bind(input.fields.requestId).first<{project_name:string|null;title:string}>();if(row)return {project:row.project_name||'',task:row.title};}
    if(input.fields.scope==='library'&&input.fields.folderId){const row=await db.prepare('SELECT name FROM aigc_folders WHERE id=?').bind(input.fields.folderId).first<{name:string}>();if(row)return {project:'',task:row.name};}
    return undefined;
  }
  /** Owner-only, currently authorised metadata. Pagination scans a bounded page before returning it. */
  async function listMine(actor:string,cursor='',filters:{name?:string;state?:string;id?:string}={}) {
    if((filters.name||'').length>200||!['all','recover','cleanup'].includes(filters.state||'all')||filters.id&&!/^[a-f0-9-]{36}$/.test(filters.id))throw new PublicError('Invalid upload selection.');
    let after:{createdAt:string;id:string}|null=null;
    if(cursor){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!value||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||typeof value.id!=='string'||!/^[a-f0-9-]{36}$/.test(value.id))throw Error();after=value;}catch{throw new PublicError('Invalid upload page.');}}
    const filterSql=(filters.name?" AND instr(lower(json_extract(payload_json,'$.file.name')),lower(?))>0":'')+(filters.state==='recover'?" AND state IN ('created','uploading','verifying') AND expires_at>?":filters.state==='cleanup'?" AND (state IN ('cancelled','expired') OR expires_at<=?)":'')+(filters.id?' AND id=?':'');
    const rows=(await db.prepare("SELECT * FROM direct_upload_sessions WHERE actor_email=? AND cleaned_at IS NULL AND state IN ('created','uploading','verifying','cancelled','expired')"+filterSql+(after?' AND (created_at>? OR (created_at=? AND id>?))':'')+' ORDER BY created_at,id LIMIT 51').bind(actor,...(filters.name?[filters.name]:[]),...(['recover','cleanup'].includes(filters.state||'')?[iso()]:[]),...(filters.id?[filters.id]:[]),...(after?[after.createdAt,after.createdAt,after.id]:[])).all<Session&{created_at:string}>()).results;
    const page=rows.slice(0,50),uploads=[],restrictedUploads:UploadRecordSummary[]=[];
    for(const row of page){
      let input:DirectUploadInput;
      try{input=parseDirectUpload(JSON.parse(row.payload_json));sessionAssets(row,input);}catch{restrictedUploads.push({id:row.id,kind:'direct',state:row.state,updatedAt:row.updated_at,reason:'INVALID_METADATA'});continue;}
      // Derived covers are implementation attachments, never user files or
      // user-facing recovery jobs. Owned cleanup and quotas still include them.
      if(input.fields.scope==='automatic-preview')continue;
      try{await deps.dispatch(actor,input,metadataFile(input.file),input.thumbnail?metadataFile(input.thumbnail):undefined,{prepareOnly:true});}
      catch(error){if(error instanceof PublicError&&[403,404,409].includes(error.status)){restrictedUploads.push({id:row.id,kind:'direct',state:row.state,updatedAt:row.updated_at,reason:'ACCESS_CHANGED'});continue;}throw error;}
      const busy=uploadClaimActive(row),interrupted=uploadClaimInterrupted(row),expired=!(Date.parse(row.expires_at)>Date.now())||row.state==='expired',active=['created','uploading','verifying'].includes(row.state);
      uploads.push({input,state:row.state,busy,interrupted,expired,canCheck:active&&!expired&&!busy,canCancel:active&&!expired&&!busy&&!interrupted&&!sessionAssets(row,input).some(asset=>asset.destinations?.some(destination=>!destination.confirmed)),updatedAt:row.updated_at,expiresAt:row.expires_at,context:await uploadContext(input)});
    }
    const last=page.at(-1);
    return {uploads,restrictedUploads,nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify({createdAt:last.created_at,id:last.id})).toString('base64url'):null};
  }
  async function create(actor:string,raw:unknown) {
    const started=performance.now();
    const input=parseDirectUpload(raw);
    const preparation=await deps.dispatch(actor,input,metadataFile(input.file),input.thumbnail?metadataFile(input.thumbnail):undefined,{prepareOnly:true});
    const parentGuard=preparedGuard(preparation),previewAuthority=await deps.previewAuthority?.(actor,input);
    if(parentGuard&&previewAuthority)Object.assign(parentGuard,{previewAuthority});
    await consumeRateLimit(db,input.fields.scope==='automatic-preview'?'preview-upload-rate':'upload-rate',actor,120,60000);
    const digest=createHash('sha256').update(JSON.stringify({...input,fields:Object.fromEntries(Object.entries(input.fields).sort())})).digest('hex');
    const existing=await db.prepare('SELECT * FROM direct_upload_sessions WHERE id=?').bind(input.id).first<Session>();
    if(existing){if(existing.actor_email!==actor||existing.request_hash!==digest)throw new PublicError('Upload identity mismatch.',409,'UPLOAD_IDENTITY_MISMATCH');const selected=(await load(actor,input.id)).row;if(selected.registration_id!==existing.registration_id||selected.request_hash!==digest)throw new PublicError('Upload identity mismatch.',409,'UPLOAD_IDENTITY_MISMATCH');return dto(selected);}
    const settings=uploadPool(input),now=iso(),scopes=await deps.scopes(input);
    const stagedCount=settings.automatic?'0':"(SELECT COUNT(*) FROM production_staged_files WHERE actor_email=? AND state IN ('uploading','ready'))";
    const stagedBytes=settings.automatic?'0':"(SELECT COALESCE(SUM(size_bytes),0) FROM production_staged_files WHERE actor_email=? AND state IN ('uploading','ready'))";
    const stagedValues=settings.automatic?[]:[actor];
    await deps.beforeCreate?.(actor,input);
    // The runtime's periodic cleaner handles old owned objects. Admission must
    // not wait for slow/failed storage deletion unrelated to this new upload.
    const assets:Asset[]=[{...input.file,slot:'file',key:`direct-upload-temporary/${input.id}/file`,handle:'',parts:{}},...(input.thumbnail?[{...input.thumbnail,slot:'thumbnail',key:`direct-upload-temporary/${input.id}/thumbnail`,handle:'',parts:{}}]:[])];
    // Reservations, not live HTTP connections, bound bytes and outstanding sessions.
    try{await guardedMutation(db,`(SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state NOT IN ('ready','cancelled','expired') AND expires_at>?) < ? AND (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state NOT IN ('ready','cancelled','expired') AND lease_expires_at>?) < ? AND (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND state NOT IN ('ready','cancelled','expired') AND lease_expires_at>?) < ? AND ${stagedCount} + (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state<>'ready' AND cleaned_at IS NULL) < ? AND ${stagedBytes} + (SELECT COALESCE(SUM(size_bytes),0) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state<>'ready' AND cleaned_at IS NULL) + ? <= ?`,[actor,now,settings.maxRetained,actor,now,settings.accountConcurrency,now,settings.siteConcurrency,...stagedValues,actor,settings.maxRetained,...stagedValues,actor,input.file.size+(input.thumbnail?.size||0),settings.maxBytes],[
      db.prepare("INSERT INTO direct_upload_sessions(id,registration_id,actor_email,request_hash,payload_json,assets_json,scopes_json,authority_json,state,created_at,updated_at,expires_at,lease_expires_at,size_bytes) VALUES(?,?,?,?,?,?,?,?,'created',?,?,?,?,?)").bind(input.id,randomUUID(),actor,digest,JSON.stringify(input),JSON.stringify(assets),JSON.stringify(scopes),JSON.stringify(preparedGuard(preparation)||null),now,now,new Date(Date.now()+settings.retention).toISOString(),new Date(Date.now()+15*60000).toISOString(),input.file.size+(input.thumbnail?.size||0)),
    ]);}catch(error){
      if(!(error instanceof PublicError&&error.code==='STALE_RECORD'))throw error;
      const counts=await db.prepare(`SELECT
        (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state NOT IN ('ready','cancelled','expired') AND expires_at>?) reserved,
        (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state NOT IN ('ready','cancelled','expired') AND lease_expires_at>?) account_active,
        (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND state NOT IN ('ready','cancelled','expired') AND lease_expires_at>?) site_active,
        ${stagedCount} + (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state<>'ready' AND cleaned_at IS NULL) staged_count,
        ${stagedBytes} + (SELECT COALESCE(SUM(size_bytes),0) FROM direct_upload_sessions WHERE ${settings.sql} AND actor_email=? AND state<>'ready' AND cleaned_at IS NULL) staged_bytes`).bind(actor,now,actor,now,now,...stagedValues,actor,...stagedValues,actor).first<{reserved:number;account_active:number;site_active:number;staged_count:number;staged_bytes:number}>();
      // This second read explains the refusal; it never grants admission or extends a lease.
      if(counts&&(counts.staged_count>=settings.maxRetained||Number(counts.staged_bytes)+input.file.size+(input.thumbnail?.size||0)>settings.maxBytes))throw new UploadAdmissionError('Temporary upload quota is full. Check or cancel retained uploads.','UPLOAD_STAGING_QUOTA');
      if(counts&&counts.reserved>=settings.maxRetained)throw new UploadAdmissionError('Too many retained uploads. Check or cancel the original uploads.','UPLOAD_RESERVATION_LIMIT');
      if(counts&&counts.account_active>=settings.accountConcurrency)throw new UploadAdmissionError('Your upload slots are occupied. Check unfinished uploads or wait for the active transfer.','UPLOAD_ACCOUNT_LIMIT');
      if(counts&&counts.site_active>=settings.siteConcurrency)throw new UploadAdmissionError('Site upload slots are occupied. Wait for an active transfer to finish.','UPLOAD_SITE_LIMIT');
      throw new UploadAdmissionError('Upload capacity changed. Check unfinished uploads before trying again.','UPLOAD_CAPACITY_CHANGED');
    }
    observe(input.id,'reserve',started);return dto((await load(actor,input.id)).row);
  }
  async function claim(actor:string,id:string,closing=false,idleSince?:string,guard?:{sql:string;values:(string|number|null)[]}) {
    const selected=await load(actor,id,!closing);if(selected.row.state==='ready')return {...selected,claim:'',previousLease:selected.row.lease_expires_at};
    const token=randomUUID(),now=iso(),limits=uploadPool(selected.input);
    // A reviewed idle reservation must still be exactly as reviewed and without an activity lease.
    const idle=idleSince===undefined?'':' AND updated_at=? AND (lease_expires_at IS NULL OR lease_expires_at<?)';
    // A caller acting for someone else (the project owner) adds its own authority to the same claim.
    const authority=guard?` AND ${guard.sql}`:'';
    const capacity=closing?'':` AND (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${limits.sql} AND id<>? AND state NOT IN ('ready','cancelled','expired') AND lease_expires_at>?) < ? AND (SELECT COUNT(*) FROM direct_upload_sessions WHERE ${limits.sql} AND id<>? AND actor_email=? AND state NOT IN ('ready','cancelled','expired') AND lease_expires_at>?) < ?`;
    try{await guardedMutation(db,"EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND actor_email=? AND registration_id=? AND state=? AND state IN ('created','uploading','verifying') AND result_json IS NULL AND assets_json=? AND expires_at>? AND (claim_id IS NULL OR lease_expires_at<?)"+idle+")"+authority+capacity,[id,actor,selected.row.registration_id,selected.row.state,selected.row.assets_json,now,now,...(idleSince===undefined?[]:[idleSince,now]),...(guard?guard.values:[]),...(closing?[]:[id,now,limits.siteConcurrency,id,actor,now,limits.accountConcurrency])],[idleSince===undefined?db.prepare('UPDATE direct_upload_sessions SET claim_id=?,lease_expires_at=?,updated_at=? WHERE id=?').bind(token,new Date(Date.now()+15*60000).toISOString(),now,id):db.prepare('UPDATE direct_upload_sessions SET claim_id=?,lease_expires_at=? WHERE id=?').bind(token,new Date(Date.now()+15*60000).toISOString(),id)]);}catch(error){if(error instanceof PublicError&&error.code==='STALE_RECORD')throw new PublicError('Upload changed or is processing. Check again.',429,'UPLOAD_SESSION_BUSY');throw error;}
    try{
      const current=await load(actor,id,!closing);
      if(current.row.claim_id!==token)throw new PublicError('Upload processing changed. Check again.',409,'UPLOAD_SESSION_BUSY');
      return {...current,claim:token,previousLease:selected.row.lease_expires_at};
    }catch(error){if(idleSince!==undefined)await db.prepare('UPDATE direct_upload_sessions SET claim_id=NULL,lease_expires_at=? WHERE id=? AND claim_id=?').bind(selected.row.lease_expires_at??null,id,token).run();else await release(id,token);throw error;}
  }
  async function release(id:string,claim:string) {if(claim)await db.prepare('UPDATE direct_upload_sessions SET claim_id=NULL,lease_expires_at=?,updated_at=? WHERE id=? AND claim_id=?').bind(new Date(Date.now()+15*60000).toISOString(),iso(),id,claim).run();}
  async function assertClaim(id:string,claim:string) {
    const row=await db.prepare("SELECT 1 FROM direct_upload_sessions WHERE id=? AND claim_id=? AND lease_expires_at>? AND expires_at>? AND state IN ('created','uploading','verifying') AND result_json IS NULL").bind(id,claim,iso(),iso()).first();
    if(!row)throw new PublicError('Upload processing changed. Check again.',409,'UPLOAD_SESSION_BUSY');
  }
  async function saveAssets(id:string,claim:string,assets:Asset[],state:string) {await guardedMutation(db,"EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND claim_id=? AND lease_expires_at>? AND expires_at>? AND state IN ('created','uploading','verifying') AND result_json IS NULL)",[id,claim,iso(),iso()],[db.prepare('UPDATE direct_upload_sessions SET assets_json=?,state=?,updated_at=? WHERE id=? AND claim_id=?').bind(JSON.stringify(assets),state,iso(),id,claim)]);}
  async function part(actor:string,id:string,slot:string,number:number,digest:string) {
    const started=performance.now();
    if(!Number.isSafeInteger(number)||number<1||!/^[A-Za-z0-9+/]{43}=$/.test(digest))throw new PublicError('Invalid upload part or checksum.');
    const {row,assets,claim:token}=await claim(actor,id);
    try {
      await consumeRateLimit(db,'direct-part-signature',actor,300,60000);
      if(row.state==='ready')throw new PublicError('Upload already completed.',409);
      const asset=assets.find(a=>a.slot===slot);if(!asset)throw denied();
      if(number>Math.ceil(asset.size/directPartSize))throw new PublicError('Invalid upload part.');
      if(asset.etag)throw new PublicError('This file is already stored. Check completion.',409,'UPLOAD_UNCONFIRMED');
      const length=directPartLength(asset.size,number),previous=asset.parts[String(number)];
      if(previous&&previous!==digest)throw new PublicError('Part identity mismatch.',409);
      await assertClaim(id,token);
      if(!asset.handle){asset.handle=await storageControl(id,'sign',()=>bucket.beginMultipart(asset.key,asset.type,id));await saveAssets(id,token,assets,'uploading');}
      asset.parts[String(number)]=digest;await saveAssets(id,token,assets,'uploading');
      const url=await storageControl(id,'sign',()=>bucket.signPart(asset.key,asset.handle,number,length,digest));observe(id,'sign',started,length);
      return {url,headers:{'x-amz-checksum-sha256':digest},expiresIn:300};
    } catch(error){if(error instanceof Error&&error.message==='DIRECT_NATIVE_VERSIONING_UNSUPPORTED')throw new PublicError('Direct transfer requires a bucket without native object versioning. Ask an administrator to review the storage configuration.',503,'DIRECT_STORAGE_VERSIONING');throw error;}
    finally {await release(id,token);}
  }
  async function status(actor:string,id:string) {
    const {row,assets}=await load(actor,id);
    const files:Record<string,{number:number;size:number;sha256:string}[]>={};
    if(row.state==='ready')return {...dto(row),files};
    if(!uploadClaimActive(row))for(const asset of assets){
      if(asset.etag)files[asset.slot]=Object.entries(asset.parts).map(([number,sha256])=>({number:Number(number),size:directPartLength(asset.size,Number(number)),sha256}));
      else if(asset.handle){try{files[asset.slot]=(await storageControl(id,'status',()=>bucket.parts(asset.key,asset.handle))).map(p=>({number:p.number,size:p.size,sha256:p.sha256}));}catch(error){const head=await storageControl(id,'status',()=>bucket.head(asset.key));if(head?.uploadOwner!==id||head.size!==asset.size)throw error;files[asset.slot]=Object.entries(asset.parts).map(([number,sha256])=>({number:Number(number),size:directPartLength(asset.size,Number(number)),sha256}));}}
    }
    return {...dto(row),files};
  }
  // The completion source is a troubleshooting marker only and is never part of the client DTO.
  async function complete(actor:string,id:string,guard?:Guard,options:CompletionOptions={}) {
    const {row,input,assets,claim:token}=await claim(actor,id,false,undefined,guard);if(row.state==='ready')return dto(row);
    let verifyLease=false,verificationExpiry=0;
    const verificationKey=input.fields.scope==='automatic-preview'?'direct-verify-preview':'direct-verify';
    // Safe yield boundaries. Storage steps that cannot be interrupted (HEAD, ListParts and the temporary upload's
    // CompleteMultipartUpload, each with its own 15/30 s limit, and the receipt's CreateMultipartUpload so that its
    // handle is saved) finish first; the next boundary then yields. No boundary is checked once registration starts.
    const yieldPoint=()=>{if(options.signal?.aborted)throw options.signal.reason??backgroundYieldError();};
    const current=async()=>{yieldPoint();await assertClaim(id,token);yieldPoint();};
    try {
      // Retain the cross-process completion lease and transaction fencing.
      const now=Date.now();
      const lock=await db.prepare("INSERT INTO security_rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at WHERE count=0 OR expires_at<=? RETURNING expires_at").bind(verificationKey,now+15*60000,now).first();
      if(!lock)throw new PublicError('File verification is busy. Check this upload shortly.',429,'UPLOAD_VERIFY_BUSY');
      verifyLease=true;
      verificationExpiry=now+15*60000;
      const files:Record<string,File>={};
      for(const asset of assets){
        await current();
        let reconciled=false;
        for(const destination of asset.destinations||[])if(!destination.confirmed){const head=await bucket.head(destination.key);if(head?.uploadOwner===id&&head.size===asset.size){destination.confirmed=true;reconciled=true;}}
        if(reconciled)await saveAssets(id,token,assets,'verifying');
        if(!asset.handle)throw new PublicError('Upload parts are missing.',409,'UPLOAD_PARTS_MISSING');
        if(!asset.etag){
          let alreadyStored=false;
          let parts:Awaited<ReturnType<WasabiBucket['parts']>>=[];
          try{parts=await bucket.parts(asset.key,asset.handle);}catch(error){const head=await bucket.head(asset.key);if(head?.size!==asset.size||head.uploadOwner!==id)throw error;alreadyStored=true;}
          if(!alreadyStored){
            if(parts.length!==Math.ceil(asset.size/directPartSize)||parts.some((p,i)=>p.number!==i+1||p.size!==directPartLength(asset.size,p.number)||!p.etag||p.sha256!==asset.parts[String(p.number)]))throw new PublicError('Upload parts do not match.',409,'UPLOAD_PARTS_MISMATCH');
            await current();
            try{await bucket.completeMultipart(asset.key,asset.handle,parts);}catch(error){if(!await bucket.head(asset.key))throw error;}
          }
          const head=await bucket.head(asset.key);if(!head||head.size!==asset.size||head.uploadOwner!==id)throw new PublicError('Stored upload ownership or size mismatch.',409);
          asset.etag=head.etag;await saveAssets(id,token,assets,'verifying');
        }
        yieldPoint();
        const verificationStarted=performance.now();
        const stored=await bucket.head(asset.key,{checksum:true});
        if(!stored||stored.size!==asset.size||stored.uploadOwner!==id||stored.etag!==asset.etag)throw new PublicError('Stored upload ownership or size mismatch.',409);
        const checksum=storedMultipartIntegrity(asset.size,asset.parts,stored);
        observe(id,'verify',verificationStarted);
        const file=storedUploadFile(asset,{key:asset.key,etag:asset.etag,sha256:checksum,promote:async(key,type)=>{
          await current();
          const previous=asset.destinations?.find(d=>d.key===key);
          if(previous){const head=await bucket.head(key);if(head?.uploadOwner===id&&head.size===asset.size){previous.confirmed=true;await saveAssets(id,token,assets,'verifying');return {etag:head.etag};}if(head)throw new PublicError('The upload destination is already in use.',409,'UPLOAD_NAME_IN_USE');if(previous.copyProtocol!=='multipart-receipt-v1')throw new PublicError('Legacy storage operation needs administrator reconciliation.',409,'UPLOAD_RECONCILIATION_REQUIRED');}
          const destination:Destination=previous||{key,confirmed:false,copyProtocol:'multipart-receipt-v1'};if(!previous)asset.destinations=[...(asset.destinations||[]),destination];await saveAssets(id,token,assets,'verifying');
          try{const started=performance.now(),result=await bucket.copy(asset.key,key,asset.etag!,type,id,true,{handle:destination.handle,created:async handle=>{destination.handle=handle;await saveAssets(id,token,assets,'verifying');},assertCurrent:current,signal:options.signal});destination.confirmed=true;await saveAssets(id,token,assets,'verifying');observe(id,'promote',started,asset.size);return result;}
          catch(error){
            // A yield keeps the receipt handle for the next pass; it is neither a storage timeout nor a conflict.
            if(options.signal?.aborted)throw options.signal.reason??backgroundYieldError();
            if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===412){
              if(destination.handle){await assertClaim(id,token);try{await bucket.abortMultipart(key,destination.handle);}catch(abortError){if((abortError as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw abortError;}}
              asset.destinations=(asset.destinations||[]).filter(d=>d!==destination);await saveAssets(id,token,assets,'verifying');
            }
            if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)){
              console.warn({event:'direct-upload.storage_timeout',sessionId:id,phase:'promote'});
              throw new PublicError('Storage promotion timed out. Check and resume this upload.',503,'DIRECT_STORAGE_TIMEOUT');
            }
            throw error;
          }
        }});files[asset.slot]=file;
      }
      // Revalidate after I/O. The business write and receipt share one transaction.
      yieldPoint();
      const preparation=await deps.dispatch(actor,input,metadataFile(input.file),input.thumbnail?metadataFile(input.thumbnail):undefined,{prepareOnly:true});
      const currentGuard=preparedGuard(preparation),originalGuard=JSON.parse(row.authority_json) as Guard|null;
      const commit:NonNullable<UploadExecution['commit']>=async(statements,result,guard)=>{
        yieldPoint();
        const started=performance.now(),foreground=options.foregroundGuard?.();
        let value;
        // From here the transaction decides: its outcome, not the yield signal, says whether registration happened.
        try{value=await guardedMutation(db,`EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND actor_email=? AND claim_id=? AND expires_at>? AND lease_expires_at>?) AND EXISTS(SELECT 1 FROM security_rate_limits WHERE key=? AND count=1 AND expires_at=? AND expires_at>?)${originalGuard?` AND (${originalGuard.sql})`:''}${currentGuard?` AND (${currentGuard.sql})`:''}${guard?` AND (${guard.sql})`:''}${foreground?` AND (${foreground.sql})`:''}`,[id,actor,token,iso(),iso(),verificationKey,verificationExpiry,Date.now(),...(originalGuard?.values||[]),...(currentGuard?.values||[]),...(guard?.values||[]),...(foreground?.values||[])],[...statements,db.prepare("UPDATE direct_upload_sessions SET state='ready',result_json=?,completion_source=?,updated_at=? WHERE id=? AND claim_id=?").bind(JSON.stringify(result),options.source||'user',iso(),id,token)]);}
        catch(error){
          // Nothing was written. Report a yield only when the foreground condition is what fails now.
          if(foreground&&error instanceof PublicError&&error.code==='STALE_RECORD'){const now=options.foregroundGuard!();if(!Number((await db.prepare(`SELECT CASE WHEN ${now.sql} THEN 1 ELSE 0 END AS clear`).bind(...now.values).first<{clear:number}>())?.clear))throw backgroundYieldError();}
          throw error;
        }
        observe(id,'register',started);return value;
      };
      yieldPoint();
      const result=await deps.dispatch(actor,input,files.file,files.thumbnail,{commit,identity:kind=>registrationIdentity(row.registration_id,kind)});
      // Cached/duplicate paths do not perform a business write and are intrinsically idempotent.
      const after=await db.prepare('SELECT state FROM direct_upload_sessions WHERE id=?').bind(id).first<{state:string}>();
      if(after?.state!=='ready')await commit([],result);
      return dto((await load(actor,id)).row);
    } finally {
      try{if(verifyLease)await db.prepare("UPDATE security_rate_limits SET count=0 WHERE key=? AND expires_at=?").bind(verificationKey,verificationExpiry).run();}finally{await release(id,token);}
    }
  }
  async function cancel(actor:string,id:string,options:{idleSince?:string;guard?:{sql:string;values:(string|number|null)[]}}={}) {
    const reviewed=await load(actor,id,false);
    if(uploadClaimInterrupted(reviewed.row)||reviewed.assets.some(asset=>asset.destinations?.some(destination=>!destination.confirmed)))throw new PublicError('Check this upload before cancelling; a storage operation is unconfirmed.',409,'UPLOAD_RECONCILIATION_REQUIRED');
    const {row,input,assets,claim:token,previousLease}=await claim(actor,id,true,options.idleSince,options.guard);
    // A failed owner cancellation returns the uploader's exact idle state so the same review can retry.
    let done=false;
    try{
      if(assets.some(asset=>asset.destinations?.some(destination=>!destination.confirmed)))throw new PublicError('Check this upload before cancelling; a storage operation is unconfirmed.',409,'UPLOAD_RECONCILIATION_REQUIRED');
      const staged=input.endpoint==='/api/production-workspace';
      const finished=staged?await db.prepare("SELECT id FROM production_staged_files WHERE id=? AND actor_email=? AND state IN ('ready','committed')").bind(id,actor).first():null;
      if(row.state==='ready'||finished)throw new PublicError('A completed upload cannot be cancelled here.',409);
      for(const asset of assets){await assertClaim(id,token);if(asset.handle&&!asset.etag){try{await bucket.abortMultipart(asset.key,asset.handle);}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error;}}const head=await bucket.head(asset.key);if(head&&head.uploadOwner!==id)throw Error('Temporary ownership changed');await assertClaim(id,token);if(head)await bucket.delete(asset.key);}
      await guardedMutation(db,`EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND actor_email=? AND claim_id=?)${staged?" AND NOT EXISTS(SELECT 1 FROM production_staged_files WHERE id=? AND actor_email=? AND state IN ('ready','committed'))":''}`,[id,actor,token,...(staged?[id,actor]:[])],[
        ...(staged?[db.prepare("UPDATE production_staged_files SET state='abandoned',updated_at=? WHERE id=? AND actor_email=? AND state='uploading'").bind(iso(),id,actor)]:[]),
        db.prepare("UPDATE direct_upload_sessions SET assets_json=?,state='cancelled',updated_at=? WHERE id=? AND claim_id=?").bind(JSON.stringify(assets),iso(),id,token),
      ]);done=true;return {ok:true};
    }
    finally{
      if(options.idleSince!==undefined&&!done&&token)await db.prepare('UPDATE direct_upload_sessions SET claim_id=NULL,lease_expires_at=? WHERE id=? AND claim_id=?').bind(previousLease??null,id,token).run();
      else await release(id,token);
    }
  }
  /** Exact persisted ownership only; never list/delete a shared bucket prefix. */
  async function cleanup(actor?:string) {
    const now=iso(),deferred:string[]=[],cleaned:string[]=[];
    // A deferred row moves behind newer candidates instead of starving cleanup.
    const rows=(await db.prepare(`SELECT * FROM direct_upload_sessions WHERE cleaned_at IS NULL AND (state IN ('ready','cancelled','expired') OR expires_at<=?) AND (claim_id IS NULL OR lease_expires_at<?)${actor?' AND actor_email=?':''} ORDER BY updated_at LIMIT 20`).bind(now,now,...(actor?[actor]:[])).all<Session>()).results;
    if(rows.length)await bucket.assertDirectReady();
    for(const row of rows){
      const token=randomUUID();
      try{
        await guardedMutation(db,"EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND registration_id=? AND cleaned_at IS NULL AND state=? AND assets_json=? AND updated_at=? AND (state IN ('ready','cancelled','expired') OR expires_at<=?) AND (claim_id IS NULL OR lease_expires_at<?))",[row.id,row.registration_id,row.state,row.assets_json,row.updated_at,now,now],[db.prepare('UPDATE direct_upload_sessions SET claim_id=?,lease_expires_at=? WHERE id=?').bind(token,new Date(Date.now()+600000).toISOString(),row.id)]);
        const assertCleanup=async()=>{if(!await db.prepare('SELECT 1 FROM direct_upload_sessions WHERE id=? AND registration_id=? AND claim_id=? AND lease_expires_at>? AND state=?').bind(row.id,row.registration_id,token,iso(),row.state).first())throw Error('Cleanup ownership changed');};
        const assets=sessionAssets(row,parseDirectUpload(JSON.parse(row.payload_json)));
        const destinationReferenced=(key:string)=>db.prepare('SELECT 1 FROM aigc_storage_objects WHERE object_key=? UNION SELECT 1 FROM production_staged_files WHERE object_key=? UNION SELECT 1 FROM project_request_documents WHERE object_key=? UNION SELECT 1 FROM aigc_file_previews WHERE object_key=? UNION SELECT 1 FROM project_files WHERE object_key=? LIMIT 1').bind(key,key,key,key,key).first();
        const resolvedAbsent=new Set<string>();
        for(const asset of assets)for(const destination of asset.destinations||[])if(!destination.confirmed){
          let head=await bucket.head(destination.key);
          // The process may have stopped after persisting the copy intent but
          // before obtaining a receipt. Do not abort a discovered, unproven
          // upload. Only reconcile absence after an exact-key lookup and re-HEAD.
          if(!head&&destination.copyProtocol==='multipart-receipt-v1'&&!destination.handle){
            await assertCleanup();
            // Expiry retains a key tombstone after deleting staged bytes. It
            // must still reserve that key, but cannot keep temporary bytes live.
            const liveReference=await db.prepare("SELECT 1 FROM aigc_storage_objects WHERE object_key=? UNION SELECT 1 FROM production_staged_files WHERE object_key=? AND state<>'expired' UNION SELECT 1 FROM project_request_documents WHERE object_key=? UNION SELECT 1 FROM aigc_file_previews WHERE object_key=? UNION SELECT 1 FROM project_files WHERE object_key=? LIMIT 1").bind(destination.key,destination.key,destination.key,destination.key,destination.key).first();
            if(liveReference)throw Error('Missing copy destination is referenced');
            if((await bucket.findMultipart(destination.key)).length)throw Error('Copy receipt missing with pending multipart');
            await assertCleanup();head=await bucket.head(destination.key);
            if(!head)resolvedAbsent.add(destination.key);
          }
          if(!head&&destination.copyProtocol==='multipart-receipt-v1'&&destination.handle){await assertCleanup();try{await bucket.abortMultipart(destination.key,destination.handle);}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error;}head=await bucket.head(destination.key);if(!head)resolvedAbsent.add(destination.key);}
          if(head?.uploadOwner===row.id&&head.size===asset.size)destination.confirmed=true;
          else if(!resolvedAbsent.has(destination.key))throw Error('Promotion requires reconciliation');
        }
        for(const asset of assets){
          await assertCleanup();
          if(!['file','thumbnail'].includes(asset.slot)||asset.key!==`direct-upload-temporary/${row.id}/${asset.slot}`)throw Error('Invalid cleanup ownership');
          if(!asset.handle)for(const handle of await bucket.findMultipart(asset.key))await bucket.abortMultipart(asset.key,handle);
          if(asset.handle&&!asset.etag){try{await bucket.abortMultipart(asset.key,asset.handle);}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error;}}
          const temporary=await bucket.head(asset.key);if(temporary&&temporary.uploadOwner!==row.id)throw Error('Temporary ownership changed');
          await assertCleanup();await bucket.delete(asset.key);
          for(const destination of asset.destinations||[]){
            if(!destination.confirmed&&!resolvedAbsent.has(destination.key))throw Error('Promotion result requires reconciliation before cleanup');
            const key=destination.key;
            const reference=await destinationReferenced(key);
            if(!reference){const head=await bucket.head(key);if(head&&head.uploadOwner!==row.id)throw Error('Destination ownership changed');await assertCleanup();await bucket.delete(key);}
          }
        }
        await db.prepare("UPDATE direct_upload_sessions SET cleaned_at=?,state=CASE WHEN state='ready' THEN 'ready' ELSE 'expired' END WHERE id=? AND claim_id=?").bind(iso(),row.id,token).run();
        cleaned.push(row.id);
      }catch(error){
        const reasons:Record<string,string>={'Copy receipt missing with pending multipart':'COPY_RECEIPT_MISSING','Missing copy destination is referenced':'REFERENCED_DESTINATION_MISSING','Promotion requires reconciliation':'COPY_UNCONFIRMED','Cleanup ownership changed':'CLAIM_CHANGED','Temporary ownership changed':'TEMPORARY_OWNER_CHANGED','Destination ownership changed':'DESTINATION_OWNER_CHANGED','Invalid persisted upload ownership':'INVALID_ASSETS','Invalid persisted copy receipt':'INVALID_COPY_RECEIPT'};
        const reason=error instanceof Error?(reasons[error.message]||(['AbortError','TimeoutError','AccessDenied'].includes(error.name)?error.name:'UNCLASSIFIED')):'UNCLASSIFIED';
        deferred.push(row.id);console.warn({event:'direct-upload.cleanup.deferred',sessionId:row.id,reason});
      }
      finally{await release(row.id,token);}
    }
    return {cleaned,deferred};
  }
  return {create,part,status,complete,cancel,cleanup,list,listMine};
}
