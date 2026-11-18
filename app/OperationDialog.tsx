"use client";
import DialogSections from "./DialogSections";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Native top-layer placement prevents a form dialog from covering feedback. */
export default function OperationDialog({title,children,onClose,onDismiss,minimizable=false,locale,closeLabel,className="",compact=false,minimizedLabel,initiallyMinimized=false}:{title:string;children:ReactNode;onClose?:()=>void;onDismiss?:()=>void;minimizable?:boolean;locale:"zh"|"en";closeLabel?:string;className?:string;compact?:boolean;minimizedLabel?:string;initiallyMinimized?:boolean}) {
  const [minimized,setMinimized]=useState(initiallyMinimized), ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(minimized)return;const node=ref.current,trigger=document.activeElement;node?.showModal();return()=>{node?.close();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus();};},[minimized]);
  if(minimized)return <button type="button" className="production-minimized operation-minimized" aria-live="polite" onClick={()=>setMinimized(false)}>{minimizedLabel || title}</button>;
  return <dialog ref={ref} className={`modal-card operation-dialog ${compact ? "compact-message-dialog" : ""} ${className}`} aria-label={title} onCancel={event=>{event.preventDefault();if(minimizable)setMinimized(true);else (onDismiss || onClose)?.();}}><DialogSections><header><h2>{title}</h2>{minimizable&&<button onClick={()=>setMinimized(true)}>{locale==="zh"?"最小化":"Minimize"}</button>}</header>{children}{onClose&&<footer><button className="primary-button" onClick={onClose}>{closeLabel||(locale==="zh"?"知道了":"OK")}</button></footer>}</DialogSections></dialog>;
}
