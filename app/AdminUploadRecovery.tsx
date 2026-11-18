"use client";
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {workspaceFetch} from '../lib/tab-session';
import {isUploadRecoveryReview,uploadRecoveryId,uploadRecoveryLabel,type UploadRecoveryReview} from '../lib/upload-recovery';
import ConfirmationDialog from './ConfirmationDialog';
import {useDraftRisk} from './useLocalDraft';

/** Exact record lookup; this page never exposes file content or storage credentials. */
export default function AdminUploadRecovery({locale}:{locale:'zh'|'en'}) {
  const zh=locale==='zh',alive=useRef(true),running=useRef(false);
  const diagnoseButton=useRef<HTMLButtonElement>(null),restoreFocus=useRef(false);
  const [id,setId]=useState(()=>typeof window==='undefined'?'':new URLSearchParams(window.location.search).get('upload')||''),[review,setReview]=useState<UploadRecoveryReview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[notice,setNotice]=useState(false);
  const selected=useRef(id);useLayoutEffect(()=>{selected.current=id;},[id]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!confirm&&restoreFocus.current){restoreFocus.current=false;diagnoseButton.current?.focus();}},[confirm]);
  useDraftRisk(busy&&confirm,'exit');
  async function diagnose(){
    if(running.current)return;
    const recordId=id.trim();setNotice(false);setError('');setReview(null);
    if(!uploadRecoveryId.test(recordId)){setError(zh?'请输入完整上传记录编号。':'Enter the complete upload record ID.');return;}
    running.current=true;setBusy(true);
    try{
      const response=await workspaceFetch(`/api/upload-recovery?${new URLSearchParams({id:recordId})}`,{cache:'no-store',signal:AbortSignal.timeout(90000)}),body=await response.json();
      if(!alive.current||selected.current.trim()!==recordId)return;
      if(!response.ok||!isUploadRecoveryReview(body)||body.id!==recordId){setError(response.status===404?(zh?'未找到该上传记录。':'Upload record not found.'):[401,403].includes(response.status)?(zh?'当前无管理员处理权限。':'Administrator permission is required.'):(zh?'核对失败，请稍后重查。':'Diagnosis failed. Check again later.'));return;}
      setReview(body);
    }catch{if(alive.current)setError(zh?'核对失败，请稍后重查。':'Diagnosis failed. Check again later.');}
    finally{running.current=false;if(alive.current)setBusy(false);}
  }
  async function abandon(){
    if(!review?.canAbandon||running.current)return false;
    const current=review;running.current=true;setBusy(true);setError('');
    try{
      const response=await workspaceFetch('/api/upload-recovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:current.id,review:current.review,checkedAt:current.checkedAt,confirmation:'ABANDON'}),signal:AbortSignal.timeout(120000)}),body=await response.json();
      if(!alive.current)return false;
      restoreFocus.current=true;setReview(null);
      if(response.ok&&body.id===current.id&&body.status==='cleaned'){setNotice(true);return true;}
      setError(zh?'清理未确认完成，请重新诊断。':'Cleanup is unconfirmed. Diagnose this record again.');return false;
    }catch{if(alive.current){restoreFocus.current=true;setReview(null);setError(zh?'清理结果待核对，请重新诊断。':'The cleanup outcome is unknown. Diagnose this record again.');}return false;}
    finally{running.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="admin-upload-recovery"><div className="page-heading"><div><h1>{zh?'上传异常处理':'Upload recovery'}</h1><p>{zh?'按记录编号核对异常上传。':'Diagnose an upload by its record ID.'}</p></div></div>
    <form className="query-bar" onSubmit={event=>{event.preventDefault();void diagnose();}}><label htmlFor="upload-recovery-id">{zh?'记录编号':'Record ID'}</label><input id="upload-recovery-id" maxLength={36} value={id} disabled={busy} onChange={event=>{setId(event.target.value);setReview(null);setNotice(false);setError('');}} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/><button ref={diagnoseButton} type="submit" className="primary-button" disabled={busy}>{busy?(zh?'处理中…':'Working…'):(zh?'诊断':'Diagnose')}</button></form>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{zh?'异常上传已清理，请返回项目重新核对删除。':'The upload was cleaned. Recheck deletion in the project.'}</p>}
    {review&&<div className="panel"><h2>{uploadRecoveryLabel(review.reason,locale)}</h2><dl><dt>{zh?'记录编号':'Record ID'}</dt><dd><code>{review.id}</code></dd><dt>{zh?'上传人':'Uploader'}</dt><dd>{review.owner||'—'}</dd><dt>{zh?'记录类型':'Record type'}</dt><dd>{review.kind==='direct'?(zh?'直传':'Direct upload'):review.kind==='legacy'?(zh?'旧上传':'Legacy upload'):(zh?'孤立暂存':'Orphan staging')}</dd><dt>{zh?'更新时间':'Updated'}</dt><dd>{review.updatedAt||'—'}</dd><dt>{zh?'保留期限':'Retention ends'}</dt><dd>{review.expiresAt||'—'}</dd>{review.storage&&<><dt>{zh?'存储核对':'Storage evidence'}</dt><dd>{zh?`对象 ${review.storage.objects}；未找到 ${review.storage.missing}；复制回执 ${review.storage.copyReceipts}`:`Objects ${review.storage.objects}; absent ${review.storage.missing}; copy receipts ${review.storage.copyReceipts}`}</dd></>}</dl>{review.canAbandon&&<button className="danger-button" type="button" disabled={busy} onClick={()=>setConfirm(true)}>{zh?'废弃此上传':'Abandon this upload'}</button>}</div>}
    {confirm&&<ConfirmationDialog title={zh?'废弃异常上传':'Abandon upload'} message={zh?'清理此记录对应的临时文件；原上传不能续传。':'Remove this upload’s temporary files. This upload cannot be resumed.'} confirmLabel={zh?'确认废弃':'Confirm abandonment'} locale={locale} close={()=>{if(!running.current){if(!review)restoreFocus.current=true;setConfirm(false);}}} confirm={abandon}/>}
  </section>;
}
