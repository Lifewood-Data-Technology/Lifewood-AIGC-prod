"use client";
import {useEffect,useReducer} from "react";
import {createPortal} from "react-dom";
import UploadProgressDialog, {type ProgressTask} from "./UploadProgressDialog";

/** Keep feedback with its originating form; detached forms fall back to the recoverable panel. */
export default function UploadFeedback({tasks,owners,locale,describe,retry,cancel,dismiss}:{tasks:ProgressTask[];owners:Map<string,HTMLElement>;locale:"zh"|"en";describe:(task:ProgressTask)=>string;retry:(id:string)=>void;cancel?:(id:string)=>void;dismiss:(ids:string[])=>void}) {
  const [,redraw]=useReducer(n=>n+1,0);
  useEffect(()=>{
    const observer=new MutationObserver(records=>{if(records.some(record=>record.type==="attributes"||[...record.removedNodes].some(node=>[...owners.values()].some(owner=>node===owner||node.contains(owner)))))redraw();});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["open"]});
    return ()=>observer.disconnect();
  },[owners]);
  const groups=new Map<HTMLElement|null,ProgressTask[]>();
  for(const task of tasks){
    const owner=owners.get(task.id);
    const visible=owner?.isConnected&&(!owner.matches("dialog")||owner.hasAttribute("open"));
    const host=visible?(owner.querySelector<HTMLElement>(".dialog-scroll-body")||owner):null;
    groups.set(host,[...(groups.get(host)||[]),task]);
  }
  return <>{[...groups].map(([host,items])=>{
    if(host?.closest('[data-upload-feedback="local"]'))return null;
    const panel=<UploadProgressDialog tasks={items} locale={locale} describe={describe} retry={retry} cancel={cancel} inline={!!host} initiallyMinimized={!host&&items.some(item=>owners.has(item.id))} dismiss={()=>dismiss(items.map(item=>item.id))}/>;
    return host?createPortal(panel,host,items[0].id):<span key="standalone">{panel}</span>;
  })}</>;
}
