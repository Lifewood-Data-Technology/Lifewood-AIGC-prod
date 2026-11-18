"use client";
import {uploadAccept, uploadTypeError, uploadSizeLabel, type UploadPurpose} from "../lib/upload-policy";
import {useUploadLimit} from "./useUploadLimit";
import {useRef,useState} from "react";
export default function UploadDropzone({locale,multiple=false,accept,disabled=false,onFiles,title,hint,maxBytes,purpose="mixed",compact=false}:{locale:"zh"|"en";multiple?:boolean;accept?:string;disabled?:boolean;onFiles:(files:File[])=>void;title?:string;hint?:string;maxBytes?:number;purpose?:UploadPurpose;compact?:boolean}) {
 const selectedLimit=useUploadLimit(),limit=maxBytes??selectedLimit;
 const [error,setError]=useState(""),[drag,setDrag]=useState(false),zh=locale==="zh";
 const input=useRef<HTMLInputElement>(null);
 const choose=(files:File[])=>{
   if(disabled||!files.length)return;
   const selected=multiple?files:files.slice(0,1);
   const invalid=selected.find(file=>!file.size||file.size>limit);
   if(invalid){setError(zh?`${invalid.name}：文件须为 1 B–${uploadSizeLabel(limit)}`:`${invalid.name}: file must be 1 B–${uploadSizeLabel(limit)}`);return;}
   const typeError=selected.map(file=>uploadTypeError(file,purpose,locale)).find(Boolean);
   if(typeError){setError(typeError);return;}
   const extensions=accept?.split(",").map(value=>value.trim().toLowerCase()).filter(Boolean);
   const wrong=extensions?.length&&selected.find(file=>!extensions.some(rule=>rule.startsWith(".")?file.name.toLowerCase().endsWith(rule):rule.endsWith("/*")?file.type.toLowerCase().startsWith(rule.slice(0,-1)):file.type.toLowerCase()===rule));
   if(wrong){setError(zh?`${wrong.name}：请选择支持的文件类型 (${accept})`:`${wrong.name}: choose a supported file type (${accept})`);return;}
   setError("");onFiles(selected);
 };
 if(compact)return <div><button type="button" className="secondary-button" disabled={disabled} onClick={()=>input.current?.click()}>{title||(zh?'选择文件':'Choose files')}</button><input ref={input} type="file" hidden accept={accept||uploadAccept(purpose)} multiple={multiple} disabled={disabled} aria-label={title||(zh?'选择文件':'Choose files')} onChange={event=>{choose(Array.from(event.target.files||[]));event.target.value='';}}/>{error&&<p role="alert">{error}</p>}</div>;
 return <div className="upload-dropzone-wrap"><label className={`upload-dropzone${drag?" is-dragging":""}${disabled?" is-disabled":""}`} onDragOver={e=>{e.preventDefault();if(!disabled)setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);choose(Array.from(e.dataTransfer.files));}}>
 <input type="file" accept={accept||uploadAccept(purpose)} multiple={multiple} disabled={disabled} aria-label={title||(zh?"选择文件":"Choose files")} onChange={e=>{choose(Array.from(e.target.files||[]));e.target.value="";}}/>
 <span className="upload-drop-icon" aria-hidden="true">↑</span><strong>{title||(zh?"将文件拖到这里，或点击选择":"Drop files here, or click to browse")}</strong><small>{hint||(multiple?(zh?"支持多选 · 选好后开始上传":"Multiple files · upload when ready"):(zh?"选择一份文件":"Choose one file"))}</small></label><div className="upload-rules"><span>{zh?"单文件最多":"Up to"} {uploadSizeLabel(limit)}{!multiple?(zh?" · 1 个文件":" · 1 file"):""}</span>{limit>=1024**3&&<span>{zh?"1 GB = 1,073,741,824 字节":"1 GB = 1,073,741,824 bytes"}</span>}{purpose==='mixed'&&!accept?<details className="upload-format-details"><summary>{zh?"图片、视频、音频、文档及工程文件 · 查看格式":"Images, video, audio, documents & project files · Formats"}</summary><p>{uploadAccept(purpose).split(',').join(' · ')}</p></details>:<span className="upload-format-rules">{(accept||uploadAccept(purpose)).split(',').join(' · ')}</span>}</div>{error&&<p className="upload-validation-error" role="alert">{error}</p>}</div>;
}
