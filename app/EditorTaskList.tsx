"use client";
import DataList, {DataListTable} from "./DataList";
import {useEffect,useRef,useState,type CSSProperties} from "react";
import {createPortal} from "react-dom";
import {groupDailyReports,reportDay} from "../lib/daily-reports";
import {languageLabel} from "../lib/business-locale";
import {openDailyReport,openMyProductionFiles} from "./ProductionWorkspace";
import {EditorFileCover} from "./EditorTaskWorkspace";
import {queryControlAnchor} from "../lib/query-control-anchor";
import {ChevronIcon} from "./ControlIcons";

type Row=Record<string,unknown>;
type SelectOption={id:string;label:string;count?:number};
export type EditorTaskListSnapshot = {
  query:string;searchInput:string;project:string;states:string[];daily:string;
  overdue:boolean;sort:string;page:number;pageSize:number;scrollY:number;
};
const str=(v:unknown)=>String(v??"");
const stages=[["todo","待制作","To do"],["doing","制作中","In production"],["revision","待修改","Revisions"],["review","待质检","In review"],["done","已完成","Completed"],["closed","已关闭","Closed"],["paused","已暂停","Paused"]];

function useFilterPopup(open:boolean) {
  const trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null);
  const [style,setStyle]=useState<CSSProperties>();
  useEffect(()=>{
    const button=trigger.current;if(!button)return;
    const field=queryControlAnchor(button);
    const click=(event:MouseEvent)=>{if(button.contains(event.target as Node))return;event.preventDefault();button.focus();button.click();};
    if(field!==button)field.addEventListener("click",click);
    return()=>field.removeEventListener("click",click);
  },[]);
  useEffect(()=>{
    if(!open)return;
    const position=()=>{
      if(!trigger.current)return;
      const rect=queryControlAnchor(trigger.current).getBoundingClientRect();
      const margin=12,gap=6,popupWidth=Math.min(rect.width,window.innerWidth-margin*2),below=window.innerHeight-rect.bottom-gap-margin;
      const openUp=below<180&&rect.top>below,available=Math.max(150,openUp?rect.top-gap-margin:below),maxHeight=Math.min(320,available);
      const top=openUp?Math.max(margin,rect.top-gap-maxHeight):rect.bottom+gap,computed=getComputedStyle(trigger.current);
      const tokens=["--bg","--surface","--surface-2","--line","--text","--muted","--accent","--accent-soft","--editor-unit"];
      setStyle({...Object.fromEntries(tokens.map(key=>[key,computed.getPropertyValue(key)])),colorScheme:computed.colorScheme,left:Math.max(margin,Math.min(rect.left,window.innerWidth-popupWidth-margin)),top,width:popupWidth,maxHeight} as CSSProperties);
    };
    position();
    const close=(event:Event)=>{if(!(trigger.current&&queryControlAnchor(trigger.current).contains(event.target as Node))&&!popup.current?.contains(event.target as Node))trigger.current?.dispatchEvent(new CustomEvent("editor-select-close"));};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();trigger.current?.dispatchEvent(new CustomEvent("editor-select-close"));trigger.current?.focus();}};
    document.addEventListener("pointerdown",close);document.addEventListener("keydown",escape);window.addEventListener("resize",position);window.addEventListener("scroll",position,true);
    return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape);window.removeEventListener("resize",position);window.removeEventListener("scroll",position,true);};
  },[open]);
  return {triggerRef:trigger,popupRef:popup,popupStyle:style};
}

function EditorSelect({label,value,placeholder,options,onChange,compact=false,allowClear=true}:{label:string;value:string;placeholder:string;options:SelectOption[];onChange:(next:string)=>void;compact?:boolean;allowClear?:boolean}) {
  const [open,setOpen]=useState(false),{triggerRef,popupRef,popupStyle}=useFilterPopup(open);
  const selected=options.find(option=>option.id===value);
  useEffect(()=>{const node=triggerRef.current;if(!node)return;const close=()=>setOpen(false);node.addEventListener("editor-select-close",close);return()=>node.removeEventListener("editor-select-close",close);},[triggerRef]);
  return <div className={`editor-filter-field${compact?" editor-filter-field--compact":""}`}>{!compact&&<span>{label}</span>}<button ref={triggerRef} type="button" className="editor-select-trigger" aria-label={compact?label:undefined} aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(current=>!current)}><span>{selected?.label||placeholder}</span><ChevronIcon/></button>
    {open&&popupStyle&&createPortal(<div ref={popupRef} className={`editor-select-popup select-popup${compact?" editor-select-popup--compact":""}`} role="listbox" aria-label={label} style={popupStyle}>{allowClear&&<button type="button" role="option" aria-selected={!value} onClick={()=>{onChange("");setOpen(false);}}><span>{placeholder}</span>{!value&&<b aria-hidden="true">✓</b>}</button>}{options.filter(option=>option.id).map(option=><button type="button" role="option" aria-selected={value===option.id} key={option.id} onClick={()=>{onChange(option.id);setOpen(false);}}><span>{option.label}</span>{value===option.id&&<b aria-hidden="true">✓</b>}</button>)}</div>,document.body)}</div>;
}

function StatusMultiSelect({label,value,options,clearLabel,selectedLabel,onChange}:{label:string;value:string[];options:SelectOption[];clearLabel:string;selectedLabel:(count:number)=>string;onChange:(next:string[])=>void}) {
  const [open,setOpen]=useState(false),{triggerRef,popupRef,popupStyle}=useFilterPopup(open);
  useEffect(()=>{const node=triggerRef.current;if(!node)return;const close=()=>setOpen(false);node.addEventListener("editor-select-close",close);return()=>node.removeEventListener("editor-select-close",close);},[triggerRef]);
  const selected=value.length===1?options.find(option=>option.id===value[0])?.label:value.length?selectedLabel(value.length):label;
  return <><button ref={triggerRef} type="button" className="editor-status-trigger editor-select-trigger" aria-haspopup="true" aria-expanded={open} onClick={()=>setOpen(current=>!current)}><span>{selected}</span>{value.length>0&&<b className="editor-selected-count">{value.length}</b>}<ChevronIcon/></button>
    {open&&popupStyle&&createPortal(<div ref={popupRef} className="editor-status-popup select-popup" role="group" aria-label={label} style={popupStyle}><div className="editor-popup-heading"><strong>{label}</strong><span>{value.length?selectedLabel(value.length):""}</span></div>{options.map(option=><label key={option.id}><input type="checkbox" checked={value.includes(option.id)} onChange={event=>onChange(event.target.checked?[...value,option.id]:value.filter(id=>id!==option.id))}/><span>{option.label}</span><em>{option.count}</em></label>)}<button type="button" onClick={()=>onChange([])}>{clearLabel}</button></div>,document.body)}</>;
}

export function editorTaskStage(value:unknown) {const s=str(value);return ["质检驳回","客户要求修改"].includes(s)?"revision":s==="制作中"?"doing":s==="待质检"?"review":s==="已终止"?"closed":s==="已暂停"?"paused":["质检通过","待客户预览","待最终确认","待交付","已交付","已归档"].includes(s)?"done":"todo";}

export default function EditorTaskList({platform,locale,search,onOpen,listSnapshot,onListSnapshot}:{platform:{languages:Row[];projects:Row[];checkpoints:Row[];fileRecords?:Row[]};locale:"zh"|"en";search:string;onOpen:(projectId:string,languageId:string)=>void;listSnapshot?:EditorTaskListSnapshot|null;onListSnapshot?:(snapshot:EditorTaskListSnapshot)=>void}) {
  const zh=locale==="zh",t=(cn:string,en:string)=>zh?cn:en;
  const [query,setQuery]=useState(listSnapshot?.query??search),[project,setProject]=useState(listSnapshot?.project??""),[states,setStates]=useState<string[]>(()=>{if(listSnapshot)return listSnapshot.states;const state=typeof window!=="undefined"?new URLSearchParams(window.location.search).get("taskStage"):null;return state&&stages.some(s=>s[0]===state)?[state]:[];}),[daily,setDaily]=useState(listSnapshot?.daily??""),[overdue,setOverdue]=useState(listSnapshot?.overdue??false),[sort,setSort]=useState(listSnapshot?.sort??""),[page,setPage]=useState(listSnapshot?.page??0);
  const [pageSize,setPageSize]=useState(listSnapshot?.pageSize??10),[searchInput,setSearchInput]=useState(listSnapshot?.searchInput??search);
  const listScroll=useRef(listSnapshot?.scrollY??0),restoreScroll=useRef(Boolean(listSnapshot));
  useEffect(()=>{if(restoreScroll.current)window.scrollTo({top:listScroll.current,behavior:"instant"});},[]);
  useEffect(()=>{onListSnapshot?.({query,searchInput,project,states,daily,overdue,sort,page,pageSize,scrollY:listScroll.current});},[onListSnapshot,query,searchInput,project,states,daily,overdue,sort,page,pageSize]);
  useEffect(()=>{const remember=()=>{listScroll.current=window.scrollY;};window.addEventListener("scroll",remember,{passive:true});return()=>window.removeEventListener("scroll",remember);},[]);
  const openTask=(projectId:string,languageId:string)=>{
    listScroll.current=window.scrollY;
    onListSnapshot?.({query,searchInput,project,states,daily,overdue,sort,page,pageSize,scrollY:listScroll.current});
    onOpen(projectId,languageId);
  };
  const today=reportDay(),reports=groupDailyReports(platform.checkpoints);
  const reported=(task:Row)=>reports.some(r=>r.date===today&&r.latest.language_project_id===task.id);
  const needsReport=(task:Row)=>["待制作","制作中","质检驳回","客户要求修改"].includes(str(task.status));
  const items:Row[]=platform.languages.map(task=>{const p=platform.projects.find(p=>p.id===task.project_id);return {...task,project_name:p?.name||task.project_name,client_name:p?.client_name||task.client_name,due_date:task.due_date||task.video_due_date||p?.due_date,priority:task.video_priority||p?.priority};});
  const matched=items.filter(item=>(!project||item.project_id===project)&&[item.project_name,item.video_name,item.client_name,item.language].map(str).join(" ").toLowerCase().includes(query.toLowerCase())&&(!overdue||!!item.due_date&&!["done","closed"].includes(editorTaskStage(item.status))&&str(item.due_date)<today)&&(!daily||(daily==="submitted"?reported(item):daily==="missing"?needsReport(item)&&!reported(item):!needsReport(item))));
  const priorityRank:Record<string,number>={urgent:0,high:1,standard:2};
  const tasks=matched.filter(item=>!states.length||states.includes(editorTaskStage(item.status))).sort((a,b)=>sort==="progress"?Number(a.production_progress||0)-Number(b.production_progress||0):sort==="due"?str(a.due_date).localeCompare(str(b.due_date)):(priorityRank[str(a.priority)]??2)-(priorityRank[str(b.priority)]??2)||str(a.due_date).localeCompare(str(b.due_date)));
  const currentPage=Math.min(page,Math.max(0,Math.ceil(tasks.length/pageSize)-1));
  const reset=()=>{setQuery("");setSearchInput("");setProject("");setStates([]);setDaily("");setOverdue(false);setSort("");setPage(0);};
  const isOverdue=(item:Row)=>!!item.due_date&&!["done","closed"].includes(editorTaskStage(item.status))&&str(item.due_date)<today;
  const reportDateLabel=new Date(`${today}T00:00:00`).toLocaleDateString(zh?"zh-CN":"en-GB",{month:"short",day:"numeric"});
  const cover=(item:Row)=>{
    const file=platform.fileRecords?.find(f=>f.language_project_id===item.id&&f.folder_code==="03.render.video"&&str(f.mime_type).startsWith("video/")&&f.current_version_id&&!f.deleted_at);
    return file?<EditorFileCover key={str(file.current_version_id)} file={{id:str(file.current_version_id),name:str(file.display_name||file.original_name),mimeType:str(file.mime_type),kind:"video",category:"03.render.video",size:Number(file.size_bytes)||0,thumbnailRevision:file.thumbnail_object_key?str(file.thumbnail_updated_at||file.thumbnail_object_key):null}}/>:<span className="editor-task-cover-empty" aria-label={t("暂无成片封面","No final cover")}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/></svg></span>;
  };
  return <div className="editor-work-area editor-task-list">
    <header className="page-heading editor-page-heading"><div><span className="eyebrow">Lifewood AIGC</span><h1>{t("任务列表","Task list")}</h1></div></header>
    <DataList className="editor-data-list" ariaLabel={t("我的任务","My tasks")}><form className="editor-section editor-task-filters" onSubmit={event=>{event.preventDefault();setQuery(searchInput);setPage(0);}}>
      <div className="editor-query-row">
        <label className="editor-task-search"><span>{t("搜索任务","Search tasks")}</span><span className="editor-search-control"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input aria-label={t("搜索任务","Search tasks")} value={searchInput} onChange={event=>setSearchInput(event.target.value)} placeholder={t("视频、项目或客户名称","Video, project or customer")}/></span></label>
        <div className="data-list-query-actions"><button type="submit" className="primary-button">{t("查询","Search")}</button><button className="query-reset-button" type="button" onClick={reset}>{t("重置筛选","Reset filters")}</button></div>
        <label className="editor-inline-check"><input type="checkbox" checked={overdue} onChange={event=>{setOverdue(event.target.checked);setPage(0);}}/>{t("仅看逾期任务","Only overdue tasks")}</label>
      </div>
      <div className="editor-filter-grid">
        <EditorSelect label={t("项目","Project")} value={project} placeholder={t("全部项目","All projects")} options={platform.projects.map(p=>({id:str(p.id),label:str(p.name)}))} onChange={next=>{setProject(next);setPage(0);}}/>
        <div className="editor-status-filter"><span>{t("任务状态","Task status")}<small>{t("（可多选）","(multiple)")}</small></span><StatusMultiSelect label={t("全部状态","All statuses")} value={states} options={stages.map(([id,cn,en])=>({id,label:t(cn,en),count:matched.filter(item=>editorTaskStage(item.status)===id).length}))} clearLabel={t("清除所选状态","Clear selected statuses")} selectedLabel={count=>t(`已选 ${count} 项`,`${count} selected`)} onChange={next=>{setStates(next);setPage(0);}}/></div>
        <EditorSelect label={t("今日日报","Today's report")} value={daily} placeholder={t("全部","All")} options={[{id:"missing",label:t("未提交","Not submitted")},{id:"submitted",label:t("已提交","Submitted")},{id:"none",label:t("无需提交","Not required")}]} onChange={next=>{setDaily(next);setPage(0);}}/>
        <EditorSelect label={t("排序方式","Sort by")} value={sort} placeholder={t("优先级与截止日期","Priority and due date")} options={[{id:"due",label:t("截止日期升序","Due date ascending")},{id:"progress",label:t("进度升序","Progress ascending")}]} onChange={next=>{setSort(next);setPage(0);}}/>
      </div>
    </form>
    <section className="editor-section">
      <header><h2>{t("我的任务","My tasks")} ({tasks.length})</h2><span className="editor-list-counts">{t("进行中","Active")} {tasks.filter(item=>!["done","closed"].includes(editorTaskStage(item.status))).length} · {t("已完成","Completed")} {tasks.filter(item=>editorTaskStage(item.status)==="done").length}{tasks.some(item=>editorTaskStage(item.status)==="closed")&&<> · {t("已关闭","Closed")} {tasks.filter(item=>editorTaskStage(item.status)==="closed").length}</>}</span></header>
      <DataListTable className="editor-table-scroll" ariaLabel={t("任务列表", "Task list")}><table className="production-task-table"><thead><tr>{[t("视频任务","Video task"),t("所属项目","Project"),t("语言","Language"),t("任务状态","Task status"),t("视频制作进度","Production progress"),t("截止日期","Due date"),t("今日日报","Today's report"),t("操作","Actions")].map(heading=><th key={heading}>{heading}</th>)}</tr></thead><tbody>{tasks.slice(currentPage*pageSize,currentPage*pageSize+pageSize).map(item=><tr key={str(item.id)}>
        <td><button className="editor-task-title" onClick={()=>openTask(str(item.project_id),str(item.id))}>{cover(item)}<strong>{str(item.video_name)||str(item.project_name)}</strong></button></td>
        <td className="editor-project-cell"><span className="editor-project-name" title={str(item.project_name)}>{str(item.project_name)}</span><small title={str(item.client_name)}>{str(item.client_name)}</small></td><td>{languageLabel(item.language_code,item.language,locale)}</td>
        <td><span className="editor-list-badge" data-tone={{blocked:"amber",todo:"gray",doing:"blue",revision:"red",review:"blue",done:"green",closed:"gray",paused:"amber"}[editorTaskStage(item.status)]}>{stages.find(stage=>stage[0]===editorTaskStage(item.status))?.[zh?1:2]}</span></td>
        <td><span className="editor-progress">{Number(item.production_progress)||0}%<progress max={100} value={Number(item.production_progress)||0}/></span></td>
        <td>{str(item.due_date)||"—"}{isOverdue(item)&&<small className="editor-overdue">{t("已逾期","Overdue")} {Math.floor((Date.parse(today)-Date.parse(str(item.due_date).slice(0,10)))/86400000)} {t("天","days")}</small>}</td>
        <td><span className="editor-list-badge" data-tone={reported(item)?"green":needsReport(item)?"amber":"gray"}>{reported(item)?t("已提交","Submitted"):needsReport(item)?t("未提交","Not submitted"):t("无需提交","Not required")}</span></td>
        <td><div className="editor-task-row-actions"><button className="row-action" onClick={()=>openTask(str(item.project_id),str(item.id))}>{t("进入工作区","Enter workspace")}</button>{needsReport(item)&&<button className="row-action" onClick={()=>openDailyReport(str(item.id),today)}>{reported(item)?t(`补充 ${reportDateLabel} 日报`,`Supplement ${reportDateLabel} report`):t(`填写 ${reportDateLabel} 日报`,`Write ${reportDateLabel} report`)}</button>}<button className="row-action" onClick={()=>openMyProductionFiles(str(item.id))}>{t("我的制作文件","My production files")}</button></div></td>
      </tr>)}</tbody></table></DataListTable>
      {!tasks.length&&<p className="editor-empty">{t("没有符合筛选条件的任务。","No tasks match these filters.")}</p>}
      <footer className="editor-pagination editor-task-pagination"><span>{t("进度、工作日报与成片版本按视频任务分别记录。","Progress, daily reports and finals are recorded per video task.")}</span><div><span>{t("共","Total")} {tasks.length} {t("条","tasks")}</span><EditorSelect compact allowClear={false} label={t("每页数量","Rows per page")} value={String(pageSize)} placeholder={t("每页数量","Rows per page")} options={[5,10,20].map(count=>({id:String(count),label:`${count}${t("条/页"," / page")}`}))} onChange={next=>{setPageSize(Number(next));setPage(0);}}/><button disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>{t("上一页","Previous")}</button><span>{currentPage+1} / {Math.max(1,Math.ceil(tasks.length/pageSize))}</span><button disabled={(currentPage+1)*pageSize>=tasks.length} onClick={()=>setPage(currentPage+1)}>{t("下一页","Next")}</button></div></footer>
    </section></DataList>
  </div>;
}
