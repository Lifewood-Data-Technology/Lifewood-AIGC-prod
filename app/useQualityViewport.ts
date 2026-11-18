"use client";
import {useLayoutEffect,type RefObject} from 'react';
import {fitQualityFrame} from '../lib/quality-viewport';
/** Size the annotation plane without coupling the result to page scroll position. */
export function useQualityViewport(viewer:RefObject<HTMLDivElement|null>,stage:RefObject<HTMLDivElement|null>,tools:RefObject<HTMLDivElement|null>,identity:string){
 useLayoutEffect(()=>{
  const host=viewer.current,plane=stage.current,consoleNode=tools.current;if(!host||!plane||!consoleNode)return;
  let frame=0,last='';
  const requestFrame=window.requestAnimationFrame?.bind(window)??((callback:FrameRequestCallback)=>window.setTimeout(()=>callback(Date.now()),16));
  const cancelFrame=window.cancelAnimationFrame?.bind(window)??window.clearTimeout.bind(window);
  const measure=()=>{
   frame=0;const style=window.getComputedStyle(host),rect=host.getBoundingClientRect(),stageRect=plane.getBoundingClientRect();
   const number=(value:string)=>Number.parseFloat(value)||0;
   const fullscreen=document.fullscreenElement===host;
   const main=host.closest('.main-content'),bar=host.closest('.workspace')?.querySelector('.topbar');
   const top=fullscreen?stageRect.top-rect.top:(bar?.getBoundingClientRect().height||0)+stageRect.top-(main?.getBoundingClientRect().top||0);
   const extras=[...host.children].filter(node=>node!==plane&&!node.classList.contains('quality-issue-board')).reduce((sum,node)=>{const s=window.getComputedStyle(node);return sum+node.getBoundingClientRect().height+number(s.marginTop)+number(s.marginBottom);},0);
   const width=Math.max(0,host.clientWidth-number(style.paddingLeft)-number(style.paddingRight));
   const available=(fullscreen?host.clientHeight:(window.visualViewport?.height||window.innerHeight))-top-extras-number(style.paddingBottom)-12;
   // Tiny viewports keep a usable scrollable player instead of clipping controls.
   const size=fitQualityFrame(width,Math.max(120,available)),value=`${size.width}:${size.height}`;
   if(size.width&&value!==last){last=value;host.style.setProperty('--quality-stage-width',`${size.width}px`);host.style.setProperty('--quality-stage-height',`${size.height}px`);}
  };
  const schedule=()=>{if(!frame)frame=requestFrame(measure);};
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);
  for(const element of [host,consoleNode,host.closest('.quality-review-console')?.querySelector('.quality-task-header'),host.closest('.quality-workbench-page'),host.closest('.main-content'),...host.children])if(element)observer?.observe(element);
  const children=new window.MutationObserver(records=>{for(const record of records){for(const node of record.removedNodes)if(node instanceof window.HTMLElement)observer?.unobserve(node);for(const node of record.addedNodes)if(node instanceof window.HTMLElement)observer?.observe(node);}schedule();});children.observe(host,{childList:true});
  window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);document.addEventListener('fullscreenchange',schedule);measure();
  return()=>{children.disconnect();observer?.disconnect();if(frame)cancelFrame(frame);window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);document.removeEventListener('fullscreenchange',schedule);host.style.removeProperty('--quality-stage-width');host.style.removeProperty('--quality-stage-height');};
 },[viewer,stage,tools,identity]);
}
