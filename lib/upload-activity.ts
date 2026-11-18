import {directTransferEnabled,directUpload} from "./direct-upload-client";
import { browserRandomUUID } from "./browser-crypto";
import {uploadDisplayMime,type UploadedFileReference} from "./upload-file-reference";
import {uploadTypeError} from "./upload-policy";
import {workspaceFetch} from "./tab-session";
export const uploadActivityEvent = "lifewood-upload-activity";
export type UploadActivity = {id:string;name:string;size:number;progress:number;phase:"uploading"|"completed"|"failed"|"unconfirmed";owner?:HTMLElement;error?:string;uploadId?:string;savedFile?:UploadedFileReference};
export function uploadOrigin() {
  const selector='dialog:not(.upload-result-dialog),[role="dialog"],.standard-upload-dialog';
  return document.activeElement?.closest<HTMLElement>(selector) || [...document.querySelectorAll<HTMLElement>('dialog[open]:not(.upload-result-dialog)')].at(-1);
}
/** Observe existing attachment requests without changing their payload, credentials or response handling. */
export async function uploadWithFeedback(url:string,init:RequestInit,file:File) {
  const error=uploadTypeError(file,url.startsWith('/api/request-documents')?'requirement':'mixed');
  if(error)return new Response(JSON.stringify({ok:false,error}),{status:400,headers:{'content-type':'application/json'}});
  const task:UploadActivity={id:browserRandomUUID(),name:file.name,size:file.size,progress:-1,phase:"uploading",owner:uploadOrigin()};
  const report=()=>window.dispatchEvent(new CustomEvent(uploadActivityEvent,{detail:{...task}}));
  report();
  try {
    const response=directTransferEnabled()&&init.body instanceof FormData?await directUpload(url as "/api/files"|"/api/request-documents",init.body,workspaceFetch,progress=>{task.progress=progress;report();},init.signal):await workspaceFetch(url,init);
    const result=await response.clone().json().catch(()=>null) as {ok?:boolean;id?:string;error?:string;code?:string;uploadId?:string}|null;
    task.phase=response.ok&&result?.ok===true&&!!result?.id?"completed":result?.code==="UPLOAD_UNCONFIRMED"?"unconfirmed":response.status>=400&&response.status<500?"failed":"unconfirmed";
    task.error=result?.error;
    if(directTransferEnabled()&&result?.uploadId)task.uploadId=result.uploadId;
    if(task.phase==='completed'&&result?.id)task.savedFile={id:result.id,storage:url.startsWith('/api/request-documents')?'requirement':'file',mimeType:uploadDisplayMime(file)};
    task.progress=100;
    report();
    return response;
  } catch(error) { task.phase="unconfirmed";task.progress=100;report();throw error; }
}
