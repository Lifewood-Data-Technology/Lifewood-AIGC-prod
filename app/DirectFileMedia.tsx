"use client";
/* eslint-disable jsx-a11y/media-has-caption -- User-provided media does not always have a caption track. */
import { useCallback, useEffect, useRef, useState, type ComponentPropsWithRef, type SyntheticEvent } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { directTransferEnabled, validateSignedTransferUrl } from "../lib/direct-upload-client";
import { useBusinessLocale } from "./BusinessText";
import { useBufferedVideo } from "./useBufferedVideo";

const eligible=(src?:string)=>Boolean(src&&/^\/api\/(?:files|request-documents|production-workspace|public-file)\?/.test(src));
type SignedFileAccess={source:string;url:string;expiresAt:number};
export function useDirectFile(src?:string){
  const active=directTransferEnabled()&&eligible(src);
  const [access,setAccess]=useState<SignedFileAccess|null>(null),[error,setError]=useState(false);
  const sequence=useRef(0),restoration=useRef<{time:number;playing:boolean}|null>(null),renewing=useRef(false);
  const pending=useRef<{source:string;request:Promise<SignedFileAccess|null>}|null>(null);
  const renew=useCallback(()=>{
    if(!src||!active)return Promise.resolve(null);
    if(pending.current?.source===src)return pending.current.request;
    const generation=++sequence.current;renewing.current=true;
    const requestedAt=Date.now();
    const request=(async()=>{
    try{
      const url=new URL(src,window.location.href);url.searchParams.set('access','1');
      const response=await workspaceFetch(url.pathname+url.search,{cache:'no-store'});
      if(!response.ok)throw Error('File access denied');
      const body=await response.json() as {url?:unknown;expiresAt?:unknown};
      if(typeof body.url!=='string'||typeof body.expiresAt!=='number')throw Error('File access unavailable');
      const signed=validateSignedTransferUrl(body.url);
      const serverDate=Date.parse(response.headers.get('date')||'');
      // HTTP Date is second-resolution. Bias earlier, and include the whole request latency.
      const expiresAt=Number.isFinite(serverDate)?requestedAt+body.expiresAt-serverDate-1000:body.expiresAt;
      if(sequence.current===generation){const access={source:src,url:signed,expiresAt};setAccess(access);setError(false);return access;}
    }catch{if(sequence.current===generation){setAccess(null);setError(true);}}
    finally{if(sequence.current===generation)renewing.current=false;}
    return null;
    })();
    pending.current={source:src,request};void request.then(()=>{if(pending.current?.request===request)pending.current=null;});return request;
  },[src,active]);
  const cancel=useCallback(()=>{sequence.current++;renewing.current=false;restoration.current=null;pending.current=null;},[]);
  useEffect(()=>{let current=true;if(active)queueMicrotask(()=>{if(current)void renew();});return()=>{current=false;cancel();};},[active,renew,cancel]);
  const remember=useCallback((node:HTMLMediaElement)=>{restoration.current={time:node.currentTime,playing:!node.paused};},[]);
  const onError=(event:SyntheticEvent<HTMLMediaElement|HTMLImageElement|HTMLIFrameElement>)=>{
    if(!active||!access||access.source!==src||Date.now()<access.expiresAt-2000||renewing.current)return false;
    const node=event.currentTarget;
    if(node instanceof HTMLMediaElement)remember(node);
    void renew();return true;
  };
  const loaded=(event:SyntheticEvent<HTMLMediaElement>)=>{const saved=restoration.current;if(saved){restoration.current=null;event.currentTarget.currentTime=saved.time;if(saved.playing)void event.currentTarget.play().catch(()=>{});}};
  return {src:active?(access&&access.source===src?access.url:undefined):src,expiresAt:access&&access.source===src?access.expiresAt:0,onError,loaded,renew,remember,error,active};
}
function ReadError(){const locale=useBusinessLocale();return <span role="alert">{locale==='en'?'File unavailable or access expired. Reopen the preview.':'文件不可用或访问已失效，请重新打开预览。'}</span>;}
function clearVideo(node:HTMLVideoElement){const loaded=node.readyState>0||!node.paused;if(loaded)node.pause();node.removeAttribute('src');if(loaded)node.load();}
/** One authorization and one page-owned cache session per mounted player. */
export function useVideoSource(src:string|undefined,controls:boolean){
  const read=useDirectFile(src),buffered=read.active&&controls;
  const buffer=useBufferedVideo(src,read.src,read.expiresAt,buffered,read.renew);
  const unavailable=read.error||buffered&&buffer.status==='failed';
  return {read,buffer,buffered,unavailable,mediaSource:unavailable?undefined:buffer.src};
}
export function FileVideo({src,onError,onLoadedMetadata,onPlay,recoverInterruptedPlayback=false,ref:forwardedRef,...props}:Omit<ComponentPropsWithRef<'video'>,'src'>&{src?:string;recoverInterruptedPlayback?:boolean}){
  const {read,buffer,buffered,unavailable,mediaSource}=useVideoSource(src,Boolean(props.controls)),locale=useBusinessLocale();
  const {remember}=read;
  const player=useRef<HTMLVideoElement|null>(null);
  const attach=useCallback((node:HTMLVideoElement|null)=>{
    player.current=node;if(!node)return;
    const cleanup=typeof forwardedRef==='function'?forwardedRef(node):undefined;
    if(forwardedRef&&typeof forwardedRef!=='function')forwardedRef.current=node;
    return()=>{if(typeof cleanup==='function')cleanup();else if(typeof forwardedRef==='function')forwardedRef(null);else if(forwardedRef)forwardedRef.current=null;};
  },[forwardedRef]);
  useEffect(()=>()=>{if(player.current)clearVideo(player.current);player.current=null;},[]);
  useEffect(()=>{if(!mediaSource&&player.current)clearVideo(player.current);},[mediaSource]);
  useEffect(()=>{if(!buffered)return;const save=()=>{if(player.current)remember(player.current);};window.addEventListener('pagehide',save);return()=>window.removeEventListener('pagehide',save);},[buffered,remember]);
  const {loadedBytes,totalBytes}=buffer.progress;
  const continueLoading=()=>{buffer.fill();const node=player.current;if(node?.error)node.load();};
  const videoError=(event:SyntheticEvent<HTMLVideoElement>)=>{
    if(recoverInterruptedPlayback&&buffer.canContinue()){read.remember(event.currentTarget);return;}
    if(!buffer.failover(()=>read.remember(event.currentTarget))&&!read.onError(event))onError?.(event);
  };
  // Cache diagnostics stay in DOM data attributes; normal playback adds no hint row or tooltip.
  return <><video {...props} ref={attach} data-preview-cache={buffered?buffer.status:undefined} data-preview-loaded-bytes={buffered?loadedBytes:undefined} data-preview-total-bytes={buffered?totalBytes:undefined} src={mediaSource} crossOrigin={read.active?'anonymous':props.crossOrigin} onPlay={event=>{buffer.fill();onPlay?.(event);}} onError={videoError} onLoadedMetadata={event=>{read.loaded(event);onLoadedMetadata?.(event);}}/>{unavailable?<ReadError/>:buffered&&recoverInterruptedPlayback&&buffer.status==='partial'&&<button type="button" onClick={continueLoading}>{locale==='en'?'Continue loading':'继续加载'}</button>}</>;
}
export function FileAudio({src,onError,onLoadedMetadata,...props}:Omit<ComponentPropsWithRef<'audio'>,'src'>&{src?:string}){const read=useDirectFile(src);return <><audio {...props} src={read.src} crossOrigin={read.active?'anonymous':props.crossOrigin} onError={event=>{if(!read.onError(event))onError?.(event);}} onLoadedMetadata={event=>{read.loaded(event);onLoadedMetadata?.(event);}}/>{read.error&&<ReadError/>}</>;}
// Private uploaded images require native browser loading and expiring URL renewal.
// eslint-disable-next-line @next/next/no-img-element
export function FileImage({src,onError,...props}:Omit<ComponentPropsWithRef<'img'>,'src'>&{src?:string}){const read=useDirectFile(src);return <><img {...props} src={read.src} crossOrigin={read.active?'anonymous':props.crossOrigin} alt={props.alt||''} onError={event=>{if(!read.onError(event))onError?.(event);}}/>{read.error&&<ReadError/>}</>;}
export function FileDocument({src,...props}:ComponentPropsWithRef<'iframe'>){const read=useDirectFile(src),locale=useBusinessLocale();return <><iframe {...props} title={props.title||"File"} src={read.src}/>{read.active&&<button type="button" onClick={()=>void read.renew()}>{locale==='en'?'Reload document':'重新加载文档'}</button>}{read.error&&<ReadError/>}</>;}
