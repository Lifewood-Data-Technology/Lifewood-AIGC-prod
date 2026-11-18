"use client";
import {uploadedFileUrl,uploadedFilePreviewable,type UploadedFileReference} from "../lib/upload-file-reference";
import type { ReactNode } from "react";
export const formatUploadSize=(size:number)=>size<1024?`${size} B`:size<1048576?`${(size/1024).toFixed(1)} KB`:`${(size/1048576).toFixed(1)} MB`;
export type UploadQueueItem = { id: string; name: string; size?: number; progress: number; phase: string; error?: string; destination?: string; storageName?: string; retryable?: boolean; resumable?: boolean; uploadId?:string; savedFile?:UploadedFileReference };
export default function UploadQueue({items,locale,describe,remove,retry,cancel,extra}:{items:UploadQueueItem[];locale:"zh"|"en";describe:(item:UploadQueueItem)=>string;remove?:(id:string)=>void;retry?:(id:string)=>void;cancel?:(id:string)=>void;extra?:(item:UploadQueueItem)=>ReactNode}) {
  const zh=locale==="zh";
  return <ul className="upload-file-list">{items.map(item=>{
    const done=["completed","ready"].includes(item.phase),active=["preparing","uploading","verifying"].includes(item.phase),uncertain=["unconfirmed","interrupted"].includes(item.phase);
    return <li key={item.id} className={`upload-file-item upload-${item.phase}`}>
      <span className="upload-file-icon" aria-hidden="true">{done?"✓":item.phase==="failed"?"!":uncertain?"?":<svg width="20" height="24" viewBox="0 0 20 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 2h8l5 5v15H4z"/><path d="M12 2v6h5"/></svg>}</span>
      <div className="upload-file-content"><strong title={item.name}>{item.name}</strong>
        <div className="upload-file-meta">{item.size!==undefined&&<span>{formatUploadSize(item.size)}</span>}<span role={item.phase==="failed"||uncertain?"alert":"status"}>{describe(item)}</span></div>
        {active&&<progress max={100} value={item.phase==="uploading"&&item.progress>=0?item.progress:undefined} aria-label={zh?`${item.name} 上传进度`:`${item.name} upload progress`}/>}
        {done&&item.destination&&<small>{zh?"保存至":"Saved to"} · {item.destination}</small>}
        {done&&item.storageName&&item.storageName!==item.name&&<details><summary>{zh?"保存文件名":"Saved filename"}</summary><small>{item.storageName}</small></details>}
        {extra?.(item)}
        {item.uploadId&&(uncertain||item.phase==='failed')&&cancel&&<button type="button" className="link-button" onClick={()=>cancel(item.id)}>{zh?'取消上传':'Cancel upload'}</button>}
      </div>
      <div className="upload-file-actions">{done&&item.savedFile&&uploadedFileUrl(item.savedFile)&&<>{uploadedFilePreviewable(item.savedFile)&&<a className="secondary-button" href={uploadedFileUrl(item.savedFile)} target="_blank" rel="noopener noreferrer" aria-label={`${zh?"预览":"Preview"} ${item.name}`}>{zh?"预览":"Preview"}</a>}<a className="secondary-button" href={uploadedFileUrl(item.savedFile,true)} aria-label={`${zh?"下载":"Download"} ${item.name}`}>{zh?"下载":"Download"}</a></>}{uncertain&&item.resumable&&retry&&<button type="button" className="secondary-button" onClick={()=>retry(item.id)}>{zh?"核对并续传":"Check and resume"}</button>}{item.phase==="failed"&&item.retryable&&retry&&<button type="button" className="secondary-button" onClick={()=>retry(item.id)}>{zh?"重试此文件":"Retry this file"}</button>}{item.phase==="queued"&&remove&&<button type="button" className="link-button" aria-label={`${zh?"移除":"Remove"} ${item.name}`} onClick={()=>remove(item.id)}>×</button>}</div>
    </li>;
  })}</ul>;
}
