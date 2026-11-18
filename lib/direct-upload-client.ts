import { hashUploadFile } from './upload-hash';
import { browserRandomUUID } from "./browser-crypto";
import { directPartLength, directPartSize, type DirectUploadInput, type DirectUploadFile } from "./direct-upload-contract";
import { checkDirectContent } from './direct-content-check';
import {uploadAdmissionReasons,type UploadAdmissionReason} from './upload-admission-error';
import {coverSessionEpoch} from './media-cover-session';
import {uploadDisplayMime} from './upload-file-reference';
import {queueAutomaticVideoPreview} from './automatic-video-preview';

export function directTransferEnabled() { return typeof document!=='undefined'&&document.querySelector<HTMLMetaElement>('meta[name="lifewood-file-transfer"]')?.content==='direct'; }
type Send = (url:string,init?:RequestInit)=>Promise<Response>;
type Envelope = {id:string;state:string;busy?:boolean;result?:Record<string,unknown>;files?:Record<string,{number:number;size:number;sha256:string}[]>};
class TransferError extends Error {constructor(message:string,readonly status=409,readonly code='UPLOAD_UNCONFIRMED',readonly headers?:Headers,readonly reasonCode?:UploadAdmissionReason){super(message);}}
const ids = new WeakMap<FormData,string>();
const uncertainFiles = new WeakMap<File,Map<string,string>>();
const uncertainFileRefs=new Map<string,WeakRef<File>>();
const uncertainForms=new Map<string,WeakRef<FormData>>();
const activeTransfers=new Set<AbortController>();
let uploadsPaused=false;
/** Stop this page's requests on exit; server reservations remain available for recovery. */
export function pauseDirectUploads(){uploadsPaused=true;for(const controller of activeTransfers)controller.abort();}
export function resumeDirectUploads(){uploadsPaused=false;}
/** Only call after the server confirms cancellation of this exact session. */
export function forgetCancelledUpload(id:string){const file=uncertainFileRefs.get(id)?.deref(),entries=file?uncertainFiles.get(file):undefined;if(entries)for(const [key,value] of entries)if(value===id)entries.delete(key);const form=uncertainForms.get(id)?.deref();if(form)ids.delete(form);uncertainFileRefs.delete(id);uncertainForms.delete(id);}
function timing(id:string,phase:'prepare'|'sign'|'transfer'|'confirm',started:number,bytes?:number){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('lifewood:direct-upload-timing',{detail:{id,phase,durationMs:Math.round(performance.now()-started),...(bytes!==undefined?{bytes}:{})}}));}
async function metadata(file:File,signal?:AbortSignal|null):Promise<DirectUploadFile>{
  return {name:file.name,type:file.type,size:file.size,sha256:await hashUploadFile(file,signal)};
}
export function validateSignedTransferUrl(value:string){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='s3.ap-southeast-1.wasabisys.com'||url.hostname.endsWith('.s3.ap-southeast-1.wasabisys.com')))throw new TransferError('Invalid storage transfer destination.',400,'INVALID_STORAGE_DESTINATION');
  return url.href;
}
// A part whose sent bytes have not advanced for this long is aborted and counts as one of its three attempts.
// Slow parts keep moving (two parallel 8 MiB parts took 111 s and 136 s on the office link) and are never cut.
const partStallMs=60000;
// Wait before the 2nd and 3rd attempt so a burst of loss can pass; each attempt is signed again.
const partRetryDelaysMs=[3000,10000];
// Page-wide cap: up to four configured files x two parts each, shared with recovery entry points.
const pagePartLimit=8;
let partRequests=0;
const waitingParts:(()=>void)[]=[];
function partSlot<T>(work:()=>Promise<T>,signal?:AbortSignal|null):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>{const index=waitingParts.indexOf(start);if(index>=0){waitingParts.splice(index,1);reject(signal?.reason);}};
    const start=()=>{signal?.removeEventListener('abort',abort);if(signal?.aborted){reject(signal.reason);return;}partRequests++;work().then(resolve,reject).finally(()=>{partRequests--;waitingParts.shift()?.();});};
    if(partRequests<pagePartLimit)start();else{waitingParts.push(start);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();}
  });
}
function retryDelay(ms:number,signal?:AbortSignal|null){
  return new Promise<void>(resolve=>{const done=()=>{signal?.removeEventListener('abort',stop);resolve();},timer=setTimeout(done,ms),stop=()=>{clearTimeout(timer);done();};signal?.addEventListener('abort',stop,{once:true});});
}
/** No Cookie, tab proof or application Authorization header is sent to Wasabi. */
function sendPart(url:string,headers:Record<string,string>,bytes:Blob,progress:(bytes:number)=>void,signal?:AbortSignal|null,reserved=false){
  return reserved?sendPartBytes(url,headers,bytes,progress,signal):partSlot(()=>sendPartBytes(url,headers,bytes,progress,signal),signal);
}
function sendPartBytes(url:string,headers:Record<string,string>,bytes:Blob,progress:(bytes:number)=>void,signal?:AbortSignal|null){
  return new Promise<void>((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',validateSignedTransferUrl(url));xhr.withCredentials=false;xhr.timeout=300000;
    for(const [key,value] of Object.entries(headers)){if(key!=='x-amz-checksum-sha256')throw new TransferError('Invalid storage header.',400);xhr.setRequestHeader(key,value);}
    // Only unsent bytes can stall; once the browser reports every byte sent, keep waiting for Wasabi's response.
    let stall:ReturnType<typeof setTimeout>|undefined,last=-1;
    const unwatch=()=>{if(stall!==undefined)clearTimeout(stall);stall=undefined;};
    const watch=(loaded:number)=>{if(loaded<=last)return;last=loaded;unwatch();if(loaded<bytes.size)stall=setTimeout(()=>{stall=undefined;xhr.abort();},partStallMs);};
    const abort=()=>xhr.abort(),cleanup=()=>{unwatch();signal?.removeEventListener('abort',abort);};signal?.addEventListener('abort',abort,{once:true});
    xhr.upload.onprogress=event=>{const loaded=Math.min(bytes.size,event.loaded);if(event.lengthComputable)progress(loaded);watch(loaded);};
    xhr.upload.onload=()=>watch(bytes.size);
    xhr.onload=()=>{cleanup();if(xhr.status>=200&&xhr.status<300){progress(bytes.size);resolve();}else reject(new TransferError('Storage part not confirmed. Check this upload.'));};
    xhr.onerror=xhr.ontimeout=xhr.onabort=()=>{cleanup();reject(new TransferError('Storage connection interrupted. Check this upload.'));};
    if(signal?.aborted){cleanup();reject(new TransferError('Upload interrupted.'));return;}xhr.send(bytes);watch(0);
  });
}

export async function directUpload(endpoint:DirectUploadInput['endpoint'],form:FormData,send:Send,onProgress:(progress:number)=>void=()=>{},signal?:AbortSignal|null,original?:DirectUploadInput):Promise<Response>{
  const file=form.get('file'),thumbnail=form.get('thumbnail');if(!(file instanceof File))return Response.json({error:'A file is required.'},{status:400});
  const identity=JSON.stringify([endpoint,[...form].filter(([key,value])=>typeof value==='string'&&key!=='actorEmail').sort(([a],[b])=>a.localeCompare(b))]);
  let fileIds=uncertainFiles.get(file);if(!fileIds){fileIds=new Map();uncertainFiles.set(file,fileIds);}
  for(const [key,reference] of uncertainFileRefs)if(!reference.deref())uncertainFileRefs.delete(key);
  for(const [key,reference] of uncertainForms)if(!reference.deref())uncertainForms.delete(key);
  let id=String(original?.id||form.get('id')||ids.get(form)||fileIds.get(identity)||'');if(!id){id=browserRandomUUID();ids.set(form,id);uncertainForms.set(id,new WeakRef(form));}fileIds.set(identity,id);uncertainFileRefs.set(id,new WeakRef(file));
  const upstream=signal,controller=new AbortController(),abort=()=>controller.abort();
  upstream?.addEventListener('abort',abort,{once:true});if(upstream?.aborted)controller.abort();signal=controller.signal;activeTransfers.add(controller);
  const checkActive=()=>{if(uploadsPaused||signal?.aborted)throw new TransferError('Upload paused. Check the original upload after signing in.');};
  const success=(result:Record<string,unknown>)=>{
    fileIds.delete(identity);uncertainFileRefs.delete(id);uncertainForms.delete(id);
    const targetId=typeof result.id==='string'?result.id:result.file&&typeof result.file==='object'&&'id' in result.file?String(result.file.id):'';
    if(typeof window!=='undefined'&&directTransferEnabled()&&targetId&&!form.get('thumbnailForVersionId')&&!form.get('parentUploadId')&&uploadDisplayMime(file).startsWith('video/')&&endpoint!=='/api/request-documents'){
      const epoch=coverSessionEpoch();
      // This work never participates in the successful main upload's outcome.
      try{queueAutomaticVideoPreview({file,parentId:id,targetId,epoch,send,upload:directUpload});}catch{/* Optional work never changes the committed video outcome. */}
    }
    return Response.json(result);
  };
  const control=async(path:string,body?:object):Promise<Envelope&{url?:string;headers?:Record<string,string>}>=>{
    checkActive();
    const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(240000)]);
    let response:Response|undefined;
    for(let attempt=0;attempt<3;attempt++){
      try{response=await send(path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),cache:'no-store',signal:requestSignal});break;}
      catch(error){
        // Read-only status checks and exact-identity part signatures are safe to repeat.
        // Never retry an HTTP failure or an unknown business write here.
        const retryable=!body||('action' in body&&['part','status'].includes(String(body.action)));
        if(controller.signal.aborted||requestSignal.aborted||!retryable||!(error instanceof TypeError)||attempt===2)throw error;
        await retryDelay(partRetryDelaysMs[attempt],controller.signal);checkActive();
      }
    }
    if(!response)throw new TransferError('Upload response unavailable.');
    const value=await response.json() as Envelope&{error?:string;code?:string;reasonCode?:UploadAdmissionReason;url?:string;headers?:Record<string,string>};
    if(!response.ok)throw new TransferError(value.error||'Upload outcome unconfirmed.',response.status,value.code||'UPLOAD_UNCONFIRMED',response.headers,value.code==='UPLOAD_BUSY'&&uploadAdmissionReasons.includes(value.reasonCode as UploadAdmissionReason)?value.reasonCode:undefined);
    requestSignal.throwIfAborted();
    if(!value||typeof value!=='object')throw new TransferError('Upload response unavailable.');checkActive();return value;
  };
  try{
    checkActive();
    onProgress(0);
    try {
      if(endpoint==='/api/request-documents')await checkDirectContent(file,'requirement');
      if(form.get('thumbnailForVersionId'))await checkDirectContent(file,'poster');
      if(thumbnail instanceof File)await checkDirectContent(thumbnail,'poster');
    } catch(error) { throw new TransferError(error instanceof Error?error.message:'Invalid file content.',400,'INVALID_UPLOAD_CONTENT'); }
    const preparing=performance.now();
    const fields:Record<string,string>=original?{...original.fields}:{};if(!original)for(const [key,value] of form)if(typeof value==='string'&&key!=='actorEmail')fields[key]=value;
    const main=await metadata(file,signal);
    if(original&&(original.endpoint!==endpoint||original.thumbnail||main.name!==original.file.name||main.size!==original.file.size||main.sha256!==original.file.sha256))throw new TransferError('Choose the original file with the same name, size and content.',400,'UPLOAD_IDENTITY_MISMATCH');
    const input:DirectUploadInput={id,endpoint,fields,file:original?{...main,type:original.file.type}:main,...(thumbnail instanceof File?{thumbnail:await metadata(thumbnail,signal)}:{})};
    timing(id,'prepare',preparing,file.size+(thumbnail instanceof File?thumbnail.size:0));
    let state=await control('/api/direct-uploads',input);const path=`/api/direct-uploads/${encodeURIComponent(id)}`;
    if(state.state==='ready'&&state.result)return success(state.result);
    state=await control(path);
    if(state.busy&&state.state!=='ready')throw new TransferError('This upload is still processing. Check it shortly.',409,'UPLOAD_SESSION_BUSY');
    if(state.state==='ready'&&state.result)return success(state.result);
    const assets=[{slot:'file',file},...(thumbnail instanceof File?[{slot:'thumbnail',file:thumbnail}]:[])],total=assets.reduce((sum,x)=>sum+x.file.size,0),sent=new Map<string,number>();
    const report=()=>onProgress(Math.min(99,Math.floor([...sent.values()].reduce((a,b)=>a+b,0)/total*100)));
    // Serialize signing/status control for this session; Wasabi PUTs remain concurrent.
    let controls:Promise<unknown>=Promise.resolve();
    const sign=(body:object)=>{const next=controls.then(()=>control(path,body));controls=next.catch(()=>{});return next;};
    for(const asset of assets){
      let cursor=1;const count=Math.ceil(asset.file.size/directPartSize);
      const worker=async()=>{while(cursor<=count){const number=cursor++,key=`${asset.slot}:${number}`,length=directPartLength(asset.file.size,number),bytes=asset.file.slice((number-1)*directPartSize,(number-1)*directPartSize+length);
        const hex=await hashUploadFile(bytes,signal),digest=btoa(String.fromCharCode(...Uint8Array.from(hex.match(/../g)!,x=>parseInt(x,16))));
        const present=state.files?.[asset.slot]?.find(p=>p.number===number);
        if(present?.size===length&&present.sha256===digest){sent.set(key,length);report();continue;}
        let confirmed=false;
        for(let attempt=0;attempt<3&&!confirmed;attempt++){
          if(attempt>0)await retryDelay(partRetryDelaysMs[attempt-1],signal);
          let signed=false;
          try{await partSlot(async()=>{
            // Sign only when this part can start; queued URLs must not expire in the queue.
            checkActive();const signing=performance.now(),permit=await sign({action:'part',slot:asset.slot,number,sha256:digest});if(!permit.url||!permit.headers)throw new TransferError('Part signature unavailable.');timing(id,'sign',signing);signed=true;
            const started=performance.now();await sendPart(permit.url,permit.headers,bytes,n=>{sent.set(key,n);report();},signal,true);timing(id,'transfer',started,bytes.size);
          },signal);confirmed=true;}
          catch(error){if(!signed||signal?.aborted)throw error;const check=await sign({action:'status'});const found=check.files?.[asset.slot]?.find(p=>p.number===number);if(found?.size===length&&found.sha256===digest){sent.set(key,length);confirmed=true;report();}else if(attempt===2)throw error;}
        }
      }};
      const outcomes=await Promise.allSettled(Array.from({length:Math.min(2,count)},worker));
      const failed=outcomes.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    }
    onProgress(99);
    const confirming=performance.now();
    let promotionRecoveries=0;
    for(let attempt=0;attempt<16;attempt++){
      try{state=await control(path,{action:'complete'});if(state.state==='ready'&&state.result){timing(id,'confirm',confirming);return success(state.result);}}
      catch(error){
        if(!(error instanceof TransferError))throw error;
        const check=await control(path);if(check.state==='ready'&&check.result)return success(check.result);
        // A timed-out copy may already exist. Resume this fenced receipt only;
        // never reserve again, resend bytes, or retry an unclassified 500.
        const recoverPromotion=error.code==='DIRECT_STORAGE_TIMEOUT'&&check.state==='verifying'&&!check.busy&&promotionRecoveries<2;
        if(recoverPromotion)promotionRecoveries++;
        if(!['UPLOAD_VERIFY_BUSY','UPLOAD_SESSION_BUSY'].includes(error.code)&&!recoverPromotion||attempt===15)throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw new TransferError('Upload result unconfirmed. Check the original upload.');
  }catch(error){
    const known=error instanceof TransferError,uncertain=!known||['UPLOAD_VERIFY_BUSY','UPLOAD_SESSION_BUSY','STALE_RECORD','UPLOAD_UNCONFIRMED','UPLOAD_PARTS_MISSING','UPLOAD_PARTS_MISMATCH','UPLOAD_RECONCILIATION_REQUIRED'].includes(error.code)||error.status>=500;
    const headers=new Headers({'cache-control':'no-store'});if(known)for(const key of ['x-lifewood-session-reason','retry-after']){const value=error.headers?.get(key);if(value)headers.set(key,value);}
    return Response.json({error:known?error.message:'Upload interrupted. Check the original upload.',code:uncertain?'UPLOAD_UNCONFIRMED':error.code,...(known&&error.reasonCode?{reasonCode:error.reasonCode}:{}),...(known&&['DIRECT_STORAGE_TIMEOUT','DIRECT_STORAGE_CONTROL_TIMEOUT'].includes(error.code)?{causeCode:error.code}:{}),uploadId:id},{status:uncertain?409:error.status,headers});
  }finally{activeTransfers.delete(controller);upstream?.removeEventListener('abort',abort);}
}

export function resumeDirectUpload(input:DirectUploadInput,file:File,send:Send,onProgress:(progress:number)=>void=()=>{},signal?:AbortSignal|null){
  const form=new FormData();form.set('file',file);
  return directUpload(input.endpoint,form,send,onProgress,signal,input);
}
