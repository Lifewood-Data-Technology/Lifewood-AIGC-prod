"use client";
import { useEffect, useState } from "react";
import { workspaceFetch } from "../../lib/tab-session";
import {useBusinessLocale} from "../BusinessText";
import { FileAudio, FileDocument, FileImage, FileVideo } from "../DirectFileMedia";

/** Stable authenticated entry; only the media element holds the expiring storage URL. */
export default function FilePreviewPage(){
  const [file,setFile]=useState<{source:string;name:string;mime:string}|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    let active=true;
    const load=async()=>{
      try{
        const raw=new URL(window.location.href).searchParams.get('source')||'',url=new URL(raw,window.location.origin);
        if(url.origin!==window.location.origin||!['/api/files','/api/production-workspace','/api/request-documents','/api/public-file'].includes(url.pathname)||url.searchParams.has('download'))throw Error('Invalid file');
        const source=url.pathname+url.search;url.searchParams.set('access','1');
        const response=await workspaceFetch(url.pathname+url.search,{cache:'no-store'});if(!response.ok)throw Error('Unavailable');
        const body=await response.json() as {name?:string;mimeType?:string;disposition?:string};
        if(body.disposition!=='inline'||!body.mimeType)throw Error('Not previewable');
        if(active)setFile({source,name:body.name||'File',mime:body.mimeType});
      }catch{if(active)setFailed(true);}
    };
    void load();return()=>{active=false;};
  },[]);
  const english=useBusinessLocale()==='en';
  if(failed)return <main><p role="alert">{english?'File unavailable or access denied. Reopen it from the workbench.':'文件不可用或无权访问，请从工作台重新打开。'}</p></main>;
  if(!file)return <main><p role="status">{english?'Loading preview…':'正在加载预览…'}</p></main>;
  const download=new URL(file.source,'http://localhost');download.searchParams.set('download','1');
  return <main style={{padding:'1rem',minHeight:'100vh'}}><h1>{file.name}</h1><a href={download.pathname+download.search}>{english?'Download':'下载'}</a><section style={{marginTop:'1rem'}}>{file.mime.startsWith('video/')?<FileVideo src={file.source} controls style={{maxWidth:'100%',maxHeight:'80vh'}}/>:file.mime.startsWith('audio/')?<FileAudio src={file.source} controls/>:file.mime.startsWith('image/')?<FileImage src={file.source} alt={file.name} style={{maxWidth:'100%',maxHeight:'80vh'}}/>:<FileDocument src={file.source} title={file.name} style={{width:'100%',height:'80vh',border:0}}/>}</section></main>;
}
