"use client";
import {useEffect,useRef,useState} from 'react';
import {workspaceFetch} from '../lib/tab-session';
import {isUploadRecordSummary,type UploadRecordSummary} from '../lib/upload-recovery';
import UploadRecordSummaries from './UploadRecordSummaries';
type History={records:UploadRecordSummary[];nextCursor:string|null};
async function readHistory(id:string,page:string,signal:AbortSignal):Promise<History> {
  const params=new URLSearchParams({mine:'1',...(page?{cursor:page}:{}),...(id?{id}:{})});
  const response=await workspaceFetch(`/api/upload-recovery?${params}`,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])}),body=await response.json();
  if(!response.ok||!Array.isArray(body.records)||!body.records.every(isUploadRecordSummary)||body.nextCursor!==null&&typeof body.nextCursor!=='string')throw Error('HISTORY_UNAVAILABLE');
  return body;
}
export default function UploadHistoryRecords({locale,id}:{locale:'zh'|'en';id:string}) {
  const [records,setRecords]=useState<UploadRecordSummary[]>([]),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(true),[refresh,setRefresh]=useState(0);
  const alive=useRef(true),running=useRef(false),controller=useRef<AbortController|null>(null),zh=locale==='zh';
  useEffect(()=>{
    alive.current=true;running.current=true;const abort=new AbortController();controller.current=abort;
    void readHistory(id,'',abort.signal).then(body=>{if(!abort.signal.aborted){setRecords(body.records);setCursor(body.nextCursor);}}).catch(()=>{if(!abort.signal.aborted)setError(true);}).finally(()=>{if(!abort.signal.aborted){running.current=false;setBusy(false);}});
    return()=>{alive.current=false;abort.abort();};
  },[id,refresh]);
  async function more(){
    if(running.current||!cursor)return;running.current=true;setBusy(true);setError(false);const abort=new AbortController();controller.current=abort;
    try{const body=await readHistory(id,cursor,abort.signal);if(alive.current&&!abort.signal.aborted){setRecords(current=>[...current,...body.records]);setCursor(body.nextCursor);}}
    catch{if(alive.current&&!abort.signal.aborted)setError(true);}
    finally{running.current=false;if(alive.current&&!abort.signal.aborted)setBusy(false);}
  }
  useEffect(()=>()=>controller.current?.abort(),[]);
  if(!records.length&&!error)return null;
  return <section aria-label={zh?'历史上传核对':'Historical uploads'}><UploadRecordSummaries records={records} locale={locale}/>{error&&<p role="alert">{zh?'历史记录读取失败，请重试。':'Historical records could not be loaded. Retry.'}</p>}<button type="button" disabled={busy} className="secondary-button" onClick={()=>{setBusy(true);setError(false);setRefresh(v=>v+1);}}>{zh?'刷新历史记录':'Refresh historical records'}</button>{cursor&&<button type="button" disabled={busy} onClick={()=>void more()}>{zh?'加载更多历史记录':'Load more historical records'}</button>}</section>;
}
