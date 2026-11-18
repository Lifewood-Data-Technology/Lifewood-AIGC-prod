"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isRecoverableDirectUpload, isRecoverableProductionUpload, type RecoverableDirectUpload, type DirectUploadInput } from "../lib/direct-upload-contract";
import { forgetCancelledUpload, resumeDirectUpload } from "../lib/direct-upload-client";
import { workspaceFetch } from "../lib/tab-session";
import { productionWorkspaceError } from "../lib/production-workspace-errors";
import { categoryUploadPurpose } from "../lib/upload-policy";
import UploadDropzone from "./UploadDropzone";
import UploadQueue from "./UploadQueue";
import { useDraftRisk } from "./useLocalDraft";
import {languageLabel} from '../lib/business-locale';
import {isUploadRecordSummary,type UploadRecordSummary} from '../lib/upload-recovery';
import UploadRecordSummaries from './UploadRecordSummaries';

const feedbackLabels:Record<string,string>={"Checking…": "正在核对…", "Upload cancelled.": "上传已取消。", "Upload confirmed.": "上传已确认。", "Recovered temporarily. Confirm in the original form.": "已恢复暂存，请在原表单确认。", "Still processing. Check again later.": "仍在处理，请稍后核对。", "Incomplete. Select the original file to resume.": "尚未完成，请选择原文件续传。"};

type RecoveredFile = { id:string; name:string; mimeType:string; size:number; kind:string; category:string; staged?:boolean };
type Props = { locale:"zh"|"en"; taskId:string; purpose:string; category?:string; excludeIds:string[]; disabled:boolean; onBusyChange:(busy:boolean)=>void; onRecovered:(file:RecoveredFile,category:string)=>void; globalList?:boolean; onSettled?:()=>void; filters?:{name:string;state:string;id?:string} };

async function recoveryRequest(path:string,init:RequestInit={},parent?:AbortSignal) {
  const timeout=AbortSignal.timeout(120000),signal=parent?AbortSignal.any([parent,timeout]):timeout;
  const response=await workspaceFetch(path,{...init,signal});
  const body=await response.json();
  signal.throwIfAborted();
  return {response,body};
}

/** Mounted in the original upload form. Lists only server-owned recovery metadata. */
export default function UnfinishedProductionUploads(props:Props) {
  const {locale,taskId,purpose,category='',excludeIds,disabled,globalList=false}=props,zh=locale==='zh';
  const [uploads,setUploads]=useState<RecoverableDirectUpload[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [restricted,setRestricted]=useState<UploadRecordSummary[]>([]);
  const [running,setRunning]=useState(''),[progress,setProgress]=useState(-1),[notice,setNotice]=useState<''|'cancelled'|'saved'|'processing'|'confirmed'>(''),[cancelConfirm,setCancelConfirm]=useState('');
  const [feedback,setFeedback]=useState<Record<string,{error:boolean;text:string}>>({});
  const [cursor,setCursor]=useState<string|null>(null);
  const [recoveredInput,setRecoveredInput]=useState<DirectUploadInput|null>(null);
  const filterName=props.filters?.name||'',filterState=props.filters?.state||'all',filterId=props.filters?.id||'';
  const noticeText=notice==='cancelled'?(zh?'上传已取消。':'Upload cancelled.'):notice==='confirmed'?(zh?'上传已确认。':'Upload confirmed.'):notice==='saved'?(zh?'已恢复暂存，请在原表单确认。':'Recovered temporarily. Confirm in the original form.'):notice==='processing'?(zh?'仍在处理，请稍后核对。':'Still processing. Check again later.') : '';
  const alive=useRef(true),operation=useRef<AbortController|null>(null),callbacks=useRef(props);
  useLayoutEffect(()=>{callbacks.current=props;},[props]);
  useDraftRisk(Boolean(running),'exit');
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current?.abort();};},[]);
  const load=useCallback(async(signal?:AbortSignal,page='')=>{
    const query:Record<string,string>=globalList?{mine:'1',...(page?{cursor:page}:{})}:{task:taskId,purpose,...(category?{category}:{})};
    if(globalList){if(filterName)query.name=filterName;query.state=filterState;if(filterId)query.id=filterId;}
    const {response,body}=await recoveryRequest(`/api/direct-uploads?${new URLSearchParams(query)}`,{cache:'no-store'},signal);
    if([401,403].includes(response.status)&&alive.current&&!signal?.aborted){setUploads([]);setRestricted([]);setCursor(null);}
    if(!response.ok||!Array.isArray(body.uploads)||!body.uploads.every((item:unknown)=>globalList?isRecoverableDirectUpload(item):isRecoverableProductionUpload(item)&&item.input.fields.task===taskId&&item.input.fields.purpose===purpose&&(!category||item.input.fields.category===category))||globalList&&body.nextCursor!==null&&typeof body.nextCursor!=='string')throw Error(body.error||'Unfinished uploads could not be loaded.');
    const summaries=globalList?(body.restrictedUploads??[]):[];
    if(!Array.isArray(summaries)||!summaries.every(isUploadRecordSummary))throw Error('Unfinished uploads could not be loaded.');
    if(alive.current&&!signal?.aborted){setUploads(current=>page?[...current.filter(item=>!body.uploads.some((next:RecoverableDirectUpload)=>next.input.id===item.input.id)),...body.uploads]:body.uploads);setRestricted(current=>page?[...current.filter(item=>!summaries.some((next:UploadRecordSummary)=>next.id===item.id)),...summaries]:summaries);setCursor(body.nextCursor||null);setError('');}
    return body.uploads as RecoverableDirectUpload[];
  },[taskId,purpose,category,globalList,filterName,filterState,filterId]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Upload recovery unavailable.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[load,locale]);
  const run=async(item:RecoverableDirectUpload,action:'check'|'cancel'|'resume',file?:File)=>{
    if(operation.current||disabled)return;
    if(item.expired||item.state==='expired'||item.state==='cancelled')return;
    setCancelConfirm('');
    const controller=new AbortController();operation.current=controller;setRunning(item.input.id);setProgress(-1);setError('');setNotice('');setFeedback(current=>({...current,[item.input.id]:{error:false,text:'Checking…'}}));callbacks.current.onBusyChange(true);
    try{
      const path=`/api/direct-uploads/${encodeURIComponent(item.input.id)}`;
      let result;
      if(action==='resume'){
        if(!file)return;
        const response=await resumeDirectUpload(item.input,file,workspaceFetch,value=>{if(alive.current&&!controller.signal.aborted)setProgress(value);},controller.signal);
        result={response,body:await response.json()};
        if(globalList&&response.ok)result=await recoveryRequest(path,{cache:'no-store'},controller.signal);
      }else if(action==='cancel')result=await recoveryRequest(path,{method:'DELETE'},controller.signal);
      else{
        result=await recoveryRequest(path,{cache:'no-store'},controller.signal);
        if(result.response.ok&&result.body.state!=='ready'&&!result.body.busy)result=await recoveryRequest(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'complete'})},controller.signal);
      }
      const {response,body}=result;
      if(!response.ok)throw Error(body.error||'Upload outcome unconfirmed.');
      if(!alive.current||controller.signal.aborted)return;
      if(action==='cancel'){
        if(body.ok!==true)throw Error('Upload cancellation unconfirmed.');
        forgetCancelledUpload(item.input.id);setNotice('cancelled');setFeedback(current=>({...current,[item.input.id]:{error:false,text:'Upload cancelled.'}}));
      }else{
        const saved=action==='resume'?body.file:body.state==='ready'?body.result?.file:null;
        if(globalList&&body.state==='ready'&&body.id===item.input.id&&body.result){
          callbacks.current.onSettled?.();setRecoveredInput(item.input);setNotice(item.input.endpoint==='/api/production-workspace'?'saved':'confirmed');setFeedback(current=>({...current,[item.input.id]:{error:false,text:'Upload confirmed.'}}));
        }else if(saved){
          if(saved.id!==item.input.id||saved.staged!==true||typeof saved.name!=='string'||typeof saved.size!=='number'||typeof saved.mimeType!=='string'||typeof saved.kind!=='string'||typeof saved.category!=='string')throw Error('Upload response identity mismatch.');
          callbacks.current.onRecovered(saved,item.input.fields.category);
          setNotice('saved');
          setFeedback(current=>({...current,[item.input.id]:{error:false,text:'Recovered temporarily. Confirm in the original form.'}}));
        }else {setNotice('processing');setFeedback(current=>({...current,[item.input.id]:{error:false,text:body.busy?'Still processing. Check again later.':'Incomplete. Select the original file to resume.'}}));}
      }
      await load(controller.signal);
    }catch(reason){if(alive.current&&!controller.signal.aborted){
      const message=reason instanceof Error?reason.message:'Upload outcome unconfirmed.';setFeedback(current=>({...current,[item.input.id]:{error:true,text:message}}));
      try{const refreshed=await load(controller.signal);if(alive.current&&!controller.signal.aborted&&!refreshed.some(row=>row.input.id===item.input.id))setError(message);}catch(refreshError){if(alive.current&&!controller.signal.aborted)setError(refreshError instanceof Error?refreshError.message:'Unfinished uploads could not be loaded.');}
    }}
    finally{if(alive.current){setRunning('');callbacks.current.onBusyChange(false);}operation.current=null;}
  };
  const visible=uploads.filter(item=>!excludeIds.includes(item.input.id));
  if(!globalList&&!loading&&!visible.length&&!error&&!notice)return null;
  return <section className="production-upload-recovery" aria-label={zh?'未完成上传':'Unfinished uploads'}>
    {!globalList&&<><strong>{zh?'未完成上传':'Unfinished uploads'}</strong><p>{zh?'核对或选择原文件续传；暂存后仍需确认提交。':'Check or resume with the original file. Confirm after temporary storage.'}</p></>}
    <button type="button" className="secondary-button" disabled={loading||Boolean(running)||disabled} onClick={()=>{setError('');setLoading(true);void load().catch(reason=>{if(alive.current)setError(reason instanceof Error?reason.message:'Upload recovery unavailable.');}).finally(()=>{if(alive.current)setLoading(false);});}}>{globalList?(zh?'刷新列表':'Refresh list'):(zh?'核对未完成上传':'Refresh unfinished uploads')}</button>
    {loading&&<p role="status">{zh?'正在读取未完成上传…':'Loading unfinished uploads…'}</p>}
    {globalList&&!loading&&!visible.length&&!restricted.length&&!error&&<p>{filterId?(zh?'该记录已结束或不在本人可访问范围。':'This record is finished or outside your accessible uploads.'):(zh?'暂无未完成上传。':'No unfinished uploads.')}</p>}
    {globalList&&<UploadRecordSummaries records={restricted} locale={locale}/>}
    {error&&<p role="alert">{productionWorkspaceError(error,locale)}</p>}{noticeText&&notice!=='processing'&&!visible.some(item=>feedback[item.input.id])&&<p role="status">{noticeText}</p>}
    {globalList&&recoveredInput?.endpoint==='/api/production-workspace'&&<button type="button" className="secondary-button" disabled={Boolean(running)||disabled} onClick={()=>{window.dispatchEvent(new CustomEvent('lifewood-production-workspace',{detail:{taskId:recoveredInput.fields.task,mode:recoveredInput.fields.purpose,recoveredFileId:recoveredInput.id}}));setRecoveredInput(null);setNotice('');}}>{zh?'返回原表单确认':'Return to original form'}</button>}
    <UploadQueue locale={locale} items={visible.map(item=>({id:item.input.id,name:item.input.file.name,size:item.input.file.size,phase:running===item.input.id?'uploading':item.state==='cancelled'?'cancelled':'unconfirmed',progress:running===item.input.id?progress:0,uploadId:item.state==='cancelled'?undefined:item.input.id}))}
      describe={queue=>{const item=visible.find(item=>item.input.id===queue.id)!;return item.state==='cancelled'?(zh?'已取消':'Cancelled'):item.expired||item.state==='expired'?(zh?'已过期':'Expired'):running===item.input.id?(progress<0?zh?'正在核对…':'Checking…':`${progress}%`):item.busy?(zh?'正在处理':'Processing'):item.interrupted?(zh?'上次处理已中断，请核对':'Interrupted; check required'):item.state==='verifying'?(zh?'上传校验待确认':'Verification unconfirmed'):zh?'未完成，可核对或续传':'Unfinished; check or resume';}}
      extra={queue=>{const item=visible.find(item=>item.input.id===queue.id)!,message=feedback[item.input.id],closed=item.expired||['cancelled','expired'].includes(item.state);return <div className="production-file-actions">
        {globalList&&<small className="upload-context">{[item.context?.project,item.context?.task,item.context?.language&&languageLabel(item.context.languageCode,item.context.language,locale),item.input.endpoint==='/api/request-documents'?(zh?'需求附件':'Requirement attachment'):item.input.fields.scope==='library'?(zh?'素材库文件':'Library file'):({materials:zh?'制作素材':'Production materials',final:zh?'成片':'Final video',daily:zh?'日报附件':'Daily report attachment',checkpoint:zh?'阶段附件':'Stage attachment'}[item.input.fields.purpose]||(zh?'项目文件':'Project file'))].filter(Boolean).join(' · ')}</small>}
        {message&&<p role={message.error?'alert':'status'}>{message.error?productionWorkspaceError(message.text,locale):zh?(feedbackLabels[message.text]||message.text):message.text}</p>}
        {!closed&&<>
        <button type="button" className="secondary-button" disabled={disabled||Boolean(running)} onClick={()=>void run(item,'check')}>{zh?'核对上传结果':'Check upload result'}</button>
        {!item.busy&&!item.input.thumbnail&&<UploadDropzone compact={globalList} locale={locale} purpose={categoryUploadPurpose(item.input.fields.category)} disabled={disabled||Boolean(running)} title={zh?'选择原文件续传':'Select original file to resume'} onFiles={files=>{if(files[0])void run(item,'resume',files[0]);}}/>}
        {!item.busy&&item.canCancel!==false&&(cancelConfirm===item.input.id?<div role="group" aria-label={zh?'确认取消上传':'Confirm upload cancellation'}><p>{zh?'取消后无法续传。':'This upload cannot be resumed after cancellation.'}</p><button type="button" className="secondary-button danger" disabled={disabled||Boolean(running)} onClick={()=>void run(item,'cancel')}>{zh?'确认取消上传':'Confirm cancel upload'}</button><button type="button" className="secondary-button" disabled={disabled||Boolean(running)} onClick={()=>setCancelConfirm('')}>{zh?'保留':'Keep it'}</button></div>:<button type="button" className="link-button" disabled={disabled||Boolean(running)} onClick={()=>setCancelConfirm(item.input.id)}>{zh?'取消上传':'Cancel upload'}</button>)}
        {item.input.thumbnail&&<small>{zh?'含配套缩略图，请回原上传入口选择两份原文件续传。':'Includes a thumbnail. Resume from the original form with both original files.'}</small>}
        </>}
        {globalList&&<small>{zh?'最近更新：':'Last updated: '}{new Date(item.updatedAt).toLocaleString(zh?'zh-CN':'en-GB')}</small>}
      </div>;}}/>
    {globalList&&cursor&&<button className="secondary-button" type="button" disabled={loading||Boolean(running)||disabled} onClick={()=>{setLoading(true);void load(undefined,cursor).catch(reason=>setError(reason instanceof Error?reason.message:'Unfinished uploads could not be loaded.')).finally(()=>setLoading(false));}}>{zh?'加载更多':'Load more'}</button>}
  </section>;
}
