"use client";
import { browserRandomUUID } from "../lib/browser-crypto";
import {useEffect,useState} from "react";
import {workspaceFetch as fetch} from "../lib/tab-session";
import {flowState,type FlowEvent,type FlowLink} from "../lib/production-flow";
import {productionWorkspaceError} from "../lib/production-workspace-errors";
import {downloadFileSet} from "../lib/browser-downloads";
import {openFlowUpload} from "./ProductionWorkspace";
type FileRow={id:string;name:string;mimeType:string;size:number;version?:number};
export type FlowData={task:Record<string,unknown>;flowEvents?:FlowEvent[];flowFiles?:FlowLink[];files:FileRow[]};
const fileUrl=(id:string,download=false)=>`/api/files?id=${encodeURIComponent(id)}${download?"&download=1":""}`;

export default function ProductionFlow({data,locale,editable=false,onChanged}:{data:FlowData;locale:"zh"|"en";editable?:boolean;onChanged?:()=>void}) {
  const t=(zh:string,en:string)=>locale==="zh"?zh:en,states=flowState(data.flowEvents||[]);
  const current=states.find(s=>!s.completed)?.id||"music";
  const [chosen,setChosen]=useState(current),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [pending,setPending]=useState<Record<string,string>|null>(null);
  const stage=states.find(s=>s.id===chosen)!,completed=states.filter(s=>s.completed).length,index=states.findIndex(s=>s.id===chosen);
  const eventFiles=(id?:string)=>(data.flowFiles||[]).filter(link=>link.event_id===id).map(link=>data.files.find(f=>f.id===link.file_version_id)).filter((file):file is FileRow=>!!file);
  const files=eventFiles(stage.delivery?.id),time=(value?:string)=>value?new Date(value).toLocaleString(locale==="zh"?"zh-CN":"en-GB",{timeZone:"Asia/Shanghai"}):"—";
  const reopen=async()=>{
    if(busy)return;setBusy(true);setError("");
    const request=pending||{kind:"flow_reopen",flowStage:chosen,languageProjectId:String(data.task.id),expectedRevision:String(data.task.revision),submissionId:browserRandomUUID()};setPending(request);
    try{const response=await fetch("/api/production-workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request),signal:AbortSignal.timeout(45000)}),body=await response.json() as {error?:string};
      if(!response.ok){if(response.status>=400&&response.status<500)setPending(null);throw Error(body.error||"Request failed");}
      setPending(null);setConfirm(false);window.dispatchEvent(new Event("lifewood-production-saved"));onChanged?.();
    }catch(e){setError(productionWorkspaceError(e instanceof Error?e.message:"",locale));}finally{setBusy(false);}
  };
  const download=async()=>{setBusy(true);setError("");try{await downloadFileSet(files.map(file=>({url:fileUrl(file.id,true),name:file.name})),`${stage.id}-files.zip`,()=>{});}catch{setError(t("下载未完成，请重试。","Download failed. Please retry."));}finally{setBusy(false);}};
  return <section className="production-flow" aria-label={t("制作流程","Production workflow")}>
    <nav className="flow-steps" aria-label={t("制作阶段","Production stages")}><header><strong>{completed}/5</strong><div><b>{t("制作流程","Production workflow")}</b><p>{t("按阶段沉淀文件，完成后进入下一步","Save files by stage, then continue to the next step")}</p></div></header>{states.map((item,i)=><button key={item.id} disabled={busy||!!pending} aria-current={chosen===item.id?"step":undefined} onClick={()=>{setChosen(item.id);setConfirm(false);setError("");}}><span className={`flow-number ${item.completed?"is-complete":""}`}>{item.completed?"✓":i+1}</span><span><b>{locale==="zh"?item.zh:item.en}</b><small>{eventFiles(item.delivery?.id).length} {t("个文件","files")}</small></span><em>{item.completed?t("已完成","Done"):item.id===current?t("进行中","In progress"):t("未开始","Not started")}</em></button>)}</nav>
    <section className="flow-detail"><header><div><small>{t(`第 ${index+1} 步，共 5 步`,`Step ${index+1} of 5`)}</small><h2>{locale==="zh"?stage.zh:stage.en}</h2><p>{locale==="zh"?stage.descriptionZh:stage.descriptionEn}</p></div><span className="flow-state">{stage.completed?t("已完成","Completed"):stage.id===current?t("进行中","In progress"):t("未开始","Not started")}</span></header>
      <dl className="flow-meta"><div><dt>{t("阶段负责人","Stage owner")}</dt><dd>{String(data.task.editor_name||t("未分配","Unassigned"))}</dd></div><div><dt>{t("最近完成","Last completed")}</dt><dd>{stage.delivery?time(stage.delivery.created_at):t("尚未完成","Not completed")}</dd></div><div><dt>{t("交付文件","Deliverables")}</dt><dd>{files.length} {t("个","files")}</dd></div></dl>
      <div className="flow-delivery-heading"><div><h3>{t("当前交付物","Current deliverables")}</h3><p>{t("这里的文件可以在上传成片时直接选择。","Select these files directly when submitting a final.")}</p></div><button disabled={busy||!files.length} onClick={()=>void download()}>{t("下载全部","Download all")}</button></div>
      <div className="flow-files">{files.map(file=><article key={file.id}><div><strong>{file.name}</strong><small>v{file.version||1} · {(file.size/1024/1024).toFixed(2)} MB</small></div><div><a href={fileUrl(file.id)} target="_blank" rel="noopener noreferrer">{t("预览","Preview")}</a><a href={fileUrl(file.id,true)}>{t("下载","Download")}</a></div></article>)}{!files.length&&<p className="flow-empty">{t("尚无可用交付文件。上传文件并确认完成后会显示在这里。","No available deliverables. Upload files and confirm completion to list them here.")}</p>}</div>
      {error&&<p role="alert">{error}</p>}
      {editable&&<div className="flow-actions">{stage.completed?<button disabled={busy} onClick={()=>setConfirm(true)}>{t("重新打开阶段","Reopen stage")}</button>:<button className="primary-button" disabled={busy||stage.id!==current} onClick={()=>openFlowUpload(String(data.task.id),stage.id)}>{t("上传文件并完成","Upload files and complete")}</button>}{!stage.completed&&stage.id!==current&&<small>{t("请先完成前面的阶段。","Complete the preceding stages first.")}</small>}</div>}
      {confirm&&<div className="flow-confirm"><p>{t("重新打开后可补充交付文件。其他阶段、历史文件、日报和已提交成片不会改变。","Reopen to update deliverables. Other stages, history, daily reports and submitted finals remain unchanged.")}</p><button disabled={busy} onClick={()=>void reopen()}>{pending?t("核对本次结果","Check this result"):t("确认重新打开","Confirm reopening")}</button><button disabled={busy||!!pending} onClick={()=>setConfirm(false)}>{t("取消","Cancel")}</button></div>}
      <section className="flow-history"><h3>{t("阶段记录","Stage history")}（{stage.history.length}）</h3>{stage.history.map(event=><details key={event.id}><summary>{event.action==="complete"?t("完成阶段","Stage completed"):t("重新打开","Reopened")} · {event.actor_name||"—"} · {time(event.created_at)}</summary>{eventFiles(event.id).map(file=><p key={file.id}><a href={fileUrl(file.id,true)}>{file.name}</a> · v{file.version||1}</p>)}</details>)}{!stage.history.length&&<p>{t("完成阶段或重新打开后，记录会显示在这里。","Completion and reopening events will appear here.")}</p>}</section>
    </section>
    <aside className="flow-rules"><h3>{t("交付规则","Delivery rules")}</h3><dl><dt>{t("完成方式","Completion")}</dt><dd>{t("剪辑师直接完成","Completed by editor")}</dd><dt>{t("文件要求","Files required")}</dt><dd>{t("至少 1 个交付文件","At least one file")}</dd><dt>{t("版本保留","Version history")}</dt><dd>{t("更新不覆盖历史记录","Updates preserve history")}</dd></dl><p>{t("工作日报记录当天工作；制作流程记录阶段交付。两者独立保存，阶段完成不会自动提交日报或质检。","Daily reports record the day's work; this workflow records stage deliverables. Completion does not submit a report or a quality review.")}</p></aside>
  </section>;
}

export function ProjectProductionFlow({taskId,locale}:{taskId:string;locale:"zh"|"en"}) {
  const [data,setData]=useState<FlowData|null>(null),[error,setError]=useState("");
  useEffect(()=>{let live=true;void fetch(`/api/production-workspace?task=${encodeURIComponent(taskId)}`,{cache:"no-store"}).then(async response=>{const body=await response.json() as FlowData & {error?:string};if(!response.ok)throw Error(body.error);if(live)setData(body);}).catch(e=>{if(live)setError(productionWorkspaceError(e.message,locale));});return()=>{live=false;};},[taskId,locale]);
  return error?<p role="alert">{error}</p>:data?<ProductionFlow key={taskId} data={data} locale={locale}/>:<p role="status">{locale==="zh"?"正在读取制作流程…":"Loading production workflow…"}</p>;
}
