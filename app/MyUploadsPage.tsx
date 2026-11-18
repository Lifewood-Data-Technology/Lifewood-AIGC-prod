"use client";
import UnfinishedProductionUploads from './UnfinishedProductionUploads';
import {directTransferEnabled} from '../lib/direct-upload-client';
import {useState} from 'react';
import UploadHistoryRecords from './UploadHistoryRecords';

export default function MyUploadsPage({locale,refresh}:{locale:'zh'|'en';refresh:()=>void}) {
  const zh=locale==='zh';
  const [name,setName]=useState(''),[state,setState]=useState('all'),[filters,setFilters]=useState({name:'',state:'all'}),[busy,setBusy]=useState(false);
  const [selectedId,setSelectedId]=useState(()=>{const id=typeof window==='undefined'?'':new URLSearchParams(window.location.search).get('upload')||'';return /^[a-f0-9-]{36}$/.test(id)?id:'';});
  return <section className="my-uploads-page"><div className="page-heading"><div><h1>{zh?'我的上传':'My uploads'}</h1><p>{zh?'查看和处理本人未完成的上传。':'Review your unfinished uploads.'}</p></div></div>
    <form className="query-bar" onSubmit={event=>{event.preventDefault();if(!busy)setFilters({name,state});}}><input disabled={busy} aria-label={zh?'搜索文件名':'Search file name'} placeholder={zh?'搜索文件名':'Search file name'} maxLength={200} value={name} onChange={event=>setName(event.target.value)}/><select disabled={busy} aria-label={zh?'上传状态':'Upload state'} value={state} onChange={event=>setState(event.target.value)}><option value="all">{zh?'全部状态':'All states'}</option><option value="recover">{zh?'待恢复':'Needs recovery'}</option><option value="cleanup">{zh?'已取消或过期':'Cancelled or expired'}</option></select><button disabled={busy} type="submit" className="secondary-button">{zh?'查询':'Search'}</button>{selectedId&&<button disabled={busy} type="button" onClick={()=>setSelectedId('')}>{zh?'显示全部上传':'Show all uploads'}</button>}</form>
    {directTransferEnabled()?<UnfinishedProductionUploads key={JSON.stringify([filters,selectedId])} locale={locale} taskId="" purpose="" excludeIds={[]} disabled={false} globalList filters={{...filters,id:selectedId}} onBusyChange={setBusy} onRecovered={()=>refresh()} onSettled={refresh}/>:<p role="status">{zh?'请返回原上传页面继续处理。':'Return to the original upload page to continue.'}</p>}
    <UploadHistoryRecords key={selectedId} locale={locale} id={selectedId}/>
  </section>;
}
