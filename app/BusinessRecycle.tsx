"use client";
import DialogSections from "./DialogSections";
import { useDraftRisk } from "./useLocalDraft";
import { useEffect, useRef, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
type Row = Record<string, unknown>;
type Locale = "zh" | "en";
const pending = (row: Row) => !row.project_id && ["submitted","needs_supplement","rejected"].includes(String(row.status));
const unconfirmedMessage = (locale: Locale) => locale === "zh"
  ? "操作结果尚未确认，可能已完成。请刷新核对，勿重复提交。"
  : "The outcome is unconfirmed and the operation may have completed. Refresh and verify before submitting again.";
async function change(body: Row, locale: Locale) {
  let response: Response;
  try {
    response = await workspaceFetch("/api/business-recycle", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  } catch { throw Error(unconfirmedMessage(locale)); }
  const result = await response.json().catch(() => null) as {ok?:boolean}|null;
  if (response.status >= 500 || (response.ok && !result?.ok)) throw Error(unconfirmedMessage(locale));
  if (!response.ok || !result?.ok) throw Error(locale === "zh" ? "未能完成：记录可能已被受理、更新，或仍有关联工作。请刷新后核对，不要重复提交未确认的操作。" : "Not completed: the record may have been accepted, changed or still have linked work. Refresh and verify before retrying.");
}
export function BusinessDeleteDialog({kind,item,requests = [],projects = [],locale,close,saved,onDeleted}: {kind:"customer"|"request";item:Row;requests?:Row[];projects?:Row[];locale:Locale;close:()=>void;saved:()=>void;onDeleted?:()=>void}) {
  const zh=locale==="zh", dialog=useRef<HTMLDialogElement>(null), sending=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const children=kind==="customer"?requests.filter(row=>row.client_id===item.id):[];
  const blocked=kind==="customer"?(projects.some(row=>row.client_id===item.id)||children.some(row=>!pending(row))):!pending(item);
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  const submit=async()=>{
    if(sending.current||blocked||error)return;
    sending.current=true;setBusy(true);
    try {await change({operation:`delete-${kind}`,id:item.id,revision:Number(kind==="customer"?item.revision:item.recycle_revision),children:children.map(row=>({id:row.id,revision:Number(row.revision),planVersion:Number(row.plan_version||0),recycleRevision:Number(row.recycle_revision),status:String(row.status)}))},locale);saved();close();onDeleted?.();}
    catch(error){setError(error instanceof Error?error.message:unconfirmedMessage(locale));}
    finally{sending.current=false;setBusy(false);}
  };
  return <dialog ref={dialog} className="account-access-dialog business-delete-dialog" aria-labelledby="business-delete-title" onCancel={event=>{event.preventDefault();if(!busy)close();}}><DialogSections>
    <header><h2 id="business-delete-title">{zh?"移入回收站":"Move to recycle bin"}</h2><button className="secondary-button" disabled={busy} onClick={close}>{zh?"关闭":"Close"}</button></header>
    <div className="account-access-dialog-body"><strong>{String(item.name||item.title)}</strong>
      {blocked?<p role="alert">{zh?"已经受理或存在正式项目，不能直接删除。请在项目中取消未完成的工作；已交付项目使用归档，保留过程记录。":"Accepted records or customers with formal projects cannot be deleted. Cancel unfinished work in the project; archive delivered projects to preserve history."}</p>:<p>{zh?"这是可恢复的删除，不会永久删除原始需求文档、文件或操作记录。":"This deletion is recoverable. Original briefs, files and audit history are retained."}</p>}
      {kind==="customer"?(blocked ? null : <><p>{zh?`同时移入回收站的待受理项目：${children.length} 个`:`Pending projects moved with this customer: ${children.length}`}</p><ul>{children.map(row=><li key={String(row.id)}>{String(row.title)}</li>)}</ul></>):<p>{zh?"仅删除此项目需求，客户及其他项目不受影响。销售和项目负责人会收到通知。":"Only this project brief is deleted. The customer and other projects are unchanged. Sales and project managers are notified."}</p>}
      {error&&<p role="alert">{error}</p>}
    </div><footer><button className="secondary-button" disabled={busy} onClick={close}>{zh?"取消":"Cancel"}</button>{error&&<button className="secondary-button" disabled={busy} onClick={()=>{saved();close();}}>{zh?"关闭并刷新核对":"Close and refresh to verify"}</button>}<button className="secondary-button danger" disabled={blocked||busy||!!error} onClick={()=>void submit()}>{busy?zh?"处理中…":"Working…":zh?"确认移入回收站":"Confirm deletion"}</button></footer>
  </DialogSections></dialog>;
}
export function BusinessRecyclePanel({locale,refresh}: {locale:Locale;refresh:()=>void}) {
  const zh=locale==="zh";
  const [items,setItems]=useState<Row[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState("");
  const sending=useRef(false), readVersion=useRef(0);
  const [unconfirmed,setUnconfirmed]=useState(false),[loading,setLoading]=useState(true);
  const load=async()=>{const version=++readVersion.current;setLoading(true);try{const response=await workspaceFetch("/api/business-recycle",{cache:"no-store",signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error();const result=await response.json() as {items:Row[]};if(!Array.isArray(result.items))throw Error();if(version!==readVersion.current)return;setItems(result.items);setError("");setUnconfirmed(false);refresh();}catch{if(version!==readVersion.current)return;setItems([]);setError(zh?"无法核对最新状态，请刷新重试。":"Unable to verify the latest state. Please refresh.");}finally{if(version===readVersion.current)setLoading(false);}};
  useEffect(()=>{
    const controller = new AbortController();
    const version=++readVersion.current;
    workspaceFetch("/api/business-recycle",{cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}).then(async response=>{if(!response.ok)throw Error();return await response.json() as {items:Row[]};}).then(result=>{if(!Array.isArray(result.items))throw Error();if(!controller.signal.aborted&&version===readVersion.current){setItems(result.items);setError("");}}).catch(()=>{if(!controller.signal.aborted&&version===readVersion.current){setItems([]);setError(zh?"无法加载，请刷新重试。":"Unable to load. Please refresh.");}}).finally(()=>{if(!controller.signal.aborted&&version===readVersion.current)setLoading(false);});
    return()=>controller.abort();
  },[zh]);
  const restore=async(item:Row)=>{if(sending.current||busy||loading||unconfirmed)return;sending.current=true;readVersion.current+=1;setBusy(String(item.id));try{await change({operation:`restore-${item.kind}`,id:item.id,revision:Number(item.revision)},locale);await load();}catch(error){setUnconfirmed(true);setError(error instanceof Error?error.message:unconfirmedMessage(locale));}finally{sending.current=false;setBusy("");}};
  return <section className="work-panel business-recycle-panel"><header><span>{zh?"客户与待受理项目":"Customers and pending projects"}</span><button className="link-button" disabled={!!busy||loading} onClick={()=>void load()}>{zh?"刷新":"Refresh"}</button></header><div className="panel-body"><p>{zh?"客户被删除时，请先恢复客户；随客户一并删除的项目会一起恢复，之前单独删除的项目不受影响。":"Restore a deleted customer first; its bundled projects are restored with it. Separately deleted projects remain in the bin."}</p>{error&&<p role="alert">{error}</p>}<div className="work-table-wrap"><table className="work-table"><thead><tr>{(zh?["名称","类型","删除时间","操作"]:["Name","Type","Deleted","Actions"]).map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{items.map(item=><tr key={`${item.kind}-${item.id}`}><td>{String(item.name)}</td><td>{item.kind==="customer"?zh?"客户":"Customer":zh?"待受理项目":"Pending project"}</td><td>{new Date(String(item.deleted_at)).toLocaleString(zh?"zh-CN":"en-GB")}</td><td><button className="link-button" disabled={!!busy||loading||unconfirmed} onClick={()=>void restore(item)}>{zh?"恢复":"Restore"}</button></td></tr>)}</tbody></table>{!items.length&&!error&&<p>{zh?"没有已删除的业务记录。":"No deleted business records."}</p>}</div></div></section>;
}

/** A batch is reviewed together, then each existing guarded deletion is confirmed individually. */
export function CustomerBatchDeleteDialog({items,requests,projects,locale,ownerEmail,close,onDeleted,refreshed}: {
  items:Row[]; requests:Row[]; projects:Row[]; locale:Locale; ownerEmail:string;
  close:()=>void; onDeleted:(ids:string[])=>void; refreshed:()=>void;
}) {
  const zh=locale==='zh', dialog=useRef<HTMLDialogElement>(null),sending=useRef(false),alive=useRef(true);
  const [busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[error,setError]=useState('');
  const [results,setResults]=useState<Record<string,'deleted'|'unconfirmed'>>({});
  useDraftRisk(busy);
  const rows=items.map(item=>{
    const children=requests.filter(row=>row.client_id===item.id);
    const blocked=item.owner_email!==ownerEmail ? (zh?'不属于当前销售':'Not owned by this sales account')
      : projects.some(row=>row.client_id===item.id)||children.some(row=>!pending(row)) ? (zh?'存在正式项目或已受理资料':'Has a formal project or accepted brief') : '';
    return {item,children,blocked};
  });
  const blocked=rows.some(row=>row.blocked)||!rows.length;
  useEffect(()=>{alive.current=true;const node=dialog.current;node?.showModal();return()=>{alive.current=false;node?.close();};},[]);
  const submit=async()=>{
    if(sending.current||attempted||blocked)return;
    sending.current=true;setBusy(true);setAttempted(true);
    const deleted:string[]=[];
    try {
      for(const {item,children} of rows) {
        if(!alive.current)break;
        const id=String(item.id);
        try {
          await change({operation:'delete-customer',id,revision:Number(item.revision),children:children.map(row=>({id:row.id,revision:Number(row.revision),planVersion:Number(row.plan_version||0),recycleRevision:Number(row.recycle_revision),status:String(row.status)}))},locale);
          deleted.push(id);
          if(alive.current)setResults(current=>({...current,[id]:'deleted'}));
        } catch(cause) {
          if(alive.current){setResults(current=>({...current,[id]:'unconfirmed'}));setError(cause instanceof Error?cause.message:unconfirmedMessage(locale));}
          break;
        }
      }
    } finally {
      sending.current=false;
      if(alive.current){setBusy(false);if(deleted.length)onDeleted(deleted);}
    }
  };
  return <dialog ref={dialog} className="account-access-dialog business-delete-dialog customer-batch-delete" aria-labelledby="customer-batch-delete-title" onCancel={event=>{event.preventDefault();if(!busy)close();}}><DialogSections>
    <header><h2 id="customer-batch-delete-title">{zh?'批量删除客户':'Delete selected customers'}</h2><button className="secondary-button" disabled={busy} onClick={close}>{zh?'关闭':'Close'}</button></header>
    <div className="account-access-dialog-body">
      <p>{zh?`已选择 ${items.length} 个客户。删除后移入回收站，可恢复；相关待受理资料将一起移入回收站。`:`${items.length} customers selected. Deletion is recoverable. Related pending briefs will also move to the recycle bin.`}</p>
      {blocked&&<p role="alert">{zh?'包含不能删除的客户，请取消这些客户的选择后再操作。':'Some customers cannot be deleted. Deselect them before continuing.'}</p>}
      <ul className="customer-batch-results">{rows.map(({item,children,blocked:reason})=><li key={String(item.id)}><div><strong>{String(item.name)}</strong><small>{zh?`${children.length} 份关联资料`:`${children.length} related briefs`}</small></div><span>{results[String(item.id)]==='deleted'?(zh?'已移入回收站':'Moved to recycle bin'):results[String(item.id)]==='unconfirmed'?(zh?'未完成 / 待核对':'Not completed / verify outcome'):reason||(attempted?(zh?'未执行':'Not attempted'):(zh?'可删除':'Eligible'))}</span></li>)}</ul>
      <p>{zh?'逐项执行；发生冲突或结果不确定时停止后续删除，请核对已完成和未执行的项目。':'Processed individually. A conflict or unconfirmed outcome stops the remaining deletions. Review each result.'}</p>
      {busy&&<p role="status">{zh?'正在删除，请勿关闭页面…':'Deleting. Keep this page open…'}</p>}
      {error&&<p role="alert">{error}</p>}
      {attempted&&!busy&&!error&&<p role="status">{zh?'所选客户已移入回收站。':'Selected customers moved to the recycle bin.'}</p>}
    </div>
    <footer><button className="secondary-button" disabled={busy} onClick={()=>{if(attempted)refreshed();close();}}>{attempted?(zh?'关闭并刷新核对':'Close and refresh to verify'):(zh?'取消':'Cancel')}</button>{!attempted&&<button className="secondary-button danger" disabled={blocked||busy} onClick={()=>void submit()}>{zh?'确认批量移入回收站':'Confirm deletion of selected customers'}</button>}</footer>
  </DialogSections></dialog>;
}
