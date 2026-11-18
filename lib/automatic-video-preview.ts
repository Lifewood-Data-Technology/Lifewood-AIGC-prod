import {frameGrabSlots} from './media-slots';
import {coverSessionEpoch,onCoverSessionReset} from './media-cover-session';
import {localVideoPoster} from './local-video-poster';
import type {DirectUploadInput} from './direct-upload-contract';

type Send=(url:string,init?:RequestInit)=>Promise<Response>;
type Upload=(endpoint:DirectUploadInput['endpoint'],form:FormData,send:Send,onProgress?:((n:number)=>void),signal?:AbortSignal|null)=>Promise<Response>;
type Job={file:File;parentId:string;targetId:string;epoch:number;send:Send;upload:Upload;controller:AbortController;result:Promise<boolean>;complete:(saved:boolean)=>void};
const waiting:Job[]=[];
const attempted=new Set<string>();
const pending=new Map<string,Promise<boolean>>();
export function automaticPreviewPending(versionId:string){return pending.get(versionId);}
let running:Job|null=null;
const diagnostic=(reason:string)=>window.dispatchEvent(new CustomEvent('lifewood:automatic-preview',{detail:{status:reason}}));
onCoverSessionReset(()=>{running?.controller.abort();for(const job of waiting){job.controller.abort();job.complete(false);}waiting.length=0;attempted.clear();pending.clear();});

/** Bounded page queue; no persistence of original files or decoded frames. */
export function queueAutomaticVideoPreview(job:Omit<Job,'controller'|'result'|'complete'>){
  if(job.epoch!==coverSessionEpoch())return;
  const identity=`${job.parentId}:${job.targetId}`;if(attempted.has(identity))return;
  if(waiting.length>=32){diagnostic('queue-full');return;}
  attempted.add(identity);if(attempted.size>512)attempted.delete(attempted.values().next().value!);
  let complete!:(saved:boolean)=>void;const result=new Promise<boolean>(resolve=>{complete=resolve;});pending.set(job.targetId,result);
  waiting.push({...job,controller:new AbortController(),result,complete});void pump();
}
async function pump(){
  if(running)return;
  const job=waiting.shift();if(!job)return;running=job;
  let release:(()=>void)|undefined,saved=false;
  const deadline=setTimeout(()=>job.controller.abort(),60000);
  try{
    if(job.epoch!==coverSessionEpoch())return;
    release=await frameGrabSlots.acquire(job.controller.signal);
    const poster=await localVideoPoster(job.file,job.controller.signal);
    release();release=undefined;
    if(!poster||job.controller.signal.aborted||job.epoch!==coverSessionEpoch()){diagnostic('not-generated');return;}
    const form=new FormData();form.set('scope','automatic-preview');form.set('parentUploadId',job.parentId);form.set('thumbnailForVersionId',job.targetId);form.set('file',new File([poster],'preview.jpg',{type:'image/jpeg'}));
    let response:Response|undefined;
    for(let attempt=0;attempt<3;attempt++){
      if(job.controller.signal.aborted||job.epoch!==coverSessionEpoch())return;
      response=await job.upload('/api/files',form,job.send,undefined,job.controller.signal);
      const admission=response.status===429?await response.clone().json().catch(()=>null) as {code?:string;reasonCode?:string}|null:null;
      if(attempt===2||admission?.code!=='UPLOAD_BUSY'||!['UPLOAD_ACCOUNT_LIMIT','UPLOAD_SITE_LIMIT','UPLOAD_CAPACITY_CHANGED'].includes(admission.reasonCode||''))break;
      // Exact same optional JPEG/form identity; retry only classified capacity
      // rejection, never an unknown write, and never beyond the job deadline.
      await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);job.controller.signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,2000);job.controller.signal.addEventListener('abort',done,{once:true});if(job.controller.signal.aborted)done();});
    }
    if(!response||job.epoch!==coverSessionEpoch())return;
    if(response.ok){saved=true;window.dispatchEvent(new CustomEvent('lifewood:automatic-preview',{detail:{status:'ready',versionId:job.targetId}}));}else{
      diagnostic('not-saved');
      const failure=await response.json().catch(()=>null) as {uploadId?:string}|null;
      if(failure?.uploadId&&/^[a-f0-9-]{36}$/.test(failure.uploadId)&&job.epoch===coverSessionEpoch()){
        // Cancel only this auxiliary session. Unknown copy outcomes remain
        // retained by the server's existing reconciliation safety rules.
        await job.send(`/api/direct-uploads/${encodeURIComponent(failure.uploadId)}`,{method:'DELETE',signal:AbortSignal.timeout(10000)}).catch(()=>undefined);
      }
    }
  }catch{diagnostic('not-generated');}
  finally{release?.();clearTimeout(deadline);if(pending.get(job.targetId)===job.result)pending.delete(job.targetId);job.complete(saved);running=null;void pump();}
}
