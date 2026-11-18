"use client";
import {useEffect,useId,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {workspaceFetch} from '../lib/tab-session';
import {adminNavigationAncestors,adminNavigationTree,initialAdminMenus,uploadRecoveryMenus,type AdminNavNode} from '../lib/admin-navigation-model';
import {parseDirectoryRecord,type DirectoryRecord} from '../lib/admin-directory';
import {MenuIcon} from './MenuIcon';

const sectionLabels:Record<string,{zh:string;en:string}> = {
 'system-group':{zh:'系统管理',en:'System management'},
 'log-group':{zh:'日志管理',en:'Logs'},
 'security-group':{zh:'安全与运维',en:'Security and operations'},
};
type LabelHint={id:string;label:string;left:number;top:number;width:number;active:string;container:Element};

/** Navigation exposes connected pages; server endpoints remain responsible for access. */
export default function AdminNavigation({active,locale,labels,navigate}:{active:string;locale:'zh'|'en';labels:Record<string,string>;navigate:(id:string)=>unknown}){
 const [configured,setConfigured]=useState<DirectoryRecord[]|null>(null);
 const navigation=useRef<HTMLElement>(null);
 const hintId=useId();
 const [hint,setHint]=useState<LabelHint|null>(null);
 useEffect(()=>{
  const controller=new AbortController();
  let generation=0;
  const load=()=>{
   const requested=++generation;
   void workspaceFetch('/api/admin-directory',{cache:'no-store',signal:controller.signal}).then(async response=>{
    if(!response.ok)return;
    const body=await response.json();
    if(!controller.signal.aborted&&requested===generation&&Array.isArray(body.directory?.menus)){
     const menus=body.directory.menus.map(parseDirectoryRecord);
     setConfigured(menus);
    }
   }).catch(()=>{/* Retain connected navigation on transient or malformed responses. */});
  };
  load();
  window.addEventListener('lifewood:admin-directory-updated',load);
  return()=>{controller.abort();window.removeEventListener('lifewood:admin-directory-updated',load);};
 },[]);
 const tree=useMemo(()=>adminNavigationTree(uploadRecoveryMenus(configured??initialAdminMenus()),labels,locale),[configured,labels,locale]);
 const ancestors=adminNavigationAncestors(tree,active);
 const context=JSON.stringify([active,ancestors]);
 const [collapse,setCollapse]=useState<{context:string;ids:string[]}>({context,ids:[]});
 // A route/configuration change opens its ancestors, while manual collapse remains available.
 const closed=collapse.context===context?collapse.ids:collapse.ids.filter(id=>!ancestors.includes(id));
 if(collapse.context!==context)setCollapse({context,ids:closed});
 useEffect(()=>{
  const container=navigation.current;
  const current=container?.querySelector<HTMLElement>('[aria-current="page"]');
  if(!container||!current||current.closest('[hidden]'))return;
  const rail=container.getBoundingClientRect(),row=current.getBoundingClientRect();
  if(row.top<rail.top)container.scrollTop-=rail.top-row.top+8;
  else if(row.bottom>rail.bottom)container.scrollTop+=row.bottom-rail.bottom+8;
 },[active,context,closed]);
 useEffect(()=>{
  const dismiss=()=>setHint(null);
  window.addEventListener('resize',dismiss);
  return()=>window.removeEventListener('resize',dismiss);
 },[]);
 const showHint=(button:HTMLButtonElement,id:string,label:string)=>{
  const text=button.querySelector('.admin-nav-label');
  if(!text||text.scrollWidth<=text.clientWidth){setHint(null);return;}
  const rect=button.getBoundingClientRect();
  const width=Math.min(320,window.innerWidth-24);
  const beside=window.innerWidth-rect.right>=width+12;
  setHint({id,label,active,width,container:button.closest('.app-shell')??document.body,left:beside?rect.right+8:Math.max(12,Math.min(rect.left+12,window.innerWidth-width-12)),top:Math.max(12,Math.min(beside?rect.top:rect.bottom+4,window.innerHeight-100))});
 };
 const visibleHint=hint?.active===active?hint:null;
 const renderNode=(node:AdminNavNode,depth=0):ReactNode=>{
  const group=node.route===null;
  const label=group&&locale==='en'&&sectionLabels[node.id]?sectionLabels[node.id].en:node.label;
  const collapsed=closed.includes(node.id);
  const button=<button
   key={node.id}
   type="button"
   className={`nav-item${group?' admin-navigation-group':''}${active===node.route?' active':''}`}
   style={{'--nav-depth':depth} as CSSProperties}
   aria-current={active===node.route?'page':undefined}
   aria-expanded={group?!collapsed:undefined}
   aria-controls={group?`nav-${node.id}`:undefined}
   aria-describedby={visibleHint?.id===node.id?hintId:undefined}
   title={label}
   onMouseEnter={event=>showHint(event.currentTarget,node.id,label)}
   onFocus={event=>showHint(event.currentTarget,node.id,label)}
   onMouseLeave={event=>{if(document.activeElement!==event.currentTarget)setHint(null);}}
   onBlur={()=>setHint(null)}
   onClick={()=>{
    setHint(null);
    if(group)setCollapse(current=>({context,ids:current.ids.includes(node.id)?current.ids.filter(id=>id!==node.id):[...current.ids,node.id]}));
    else if(node.route)navigate(node.route);
   }}
  ><MenuIcon name={node.icon}/><span className="admin-nav-label">{label}</span>{group&&<svg className="admin-nav-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}</button>;
  return group?<section key={node.id} className={depth?'admin-navigation-nested':undefined} data-depth={depth}>{button}<div id={`nav-${node.id}`} hidden={collapsed}>{node.children.map(child=>renderNode(child,depth+1))}</div></section>:button;
 };
 return <>
  <nav ref={navigation} className="admin-navigation" aria-label={locale==='zh'?'管理员导航':'Administrator navigation'} onScroll={()=>setHint(null)}>{tree.map(node=>renderNode(node))}</nav>
  {visibleHint&&createPortal(<div id={hintId} role="tooltip" className="sidebar-nav-tooltip" style={{left:visibleHint.left,top:visibleHint.top,maxWidth:visibleHint.width}}>{visibleHint.label}</div>,visibleHint.container)}
 </>;
}
