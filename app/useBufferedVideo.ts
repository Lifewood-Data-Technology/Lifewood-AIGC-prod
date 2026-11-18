"use client";
import {useEffect,useRef,useState} from 'react';
import {openVideoBuffer,videoBufferSupported,type VideoBuffer} from '../lib/video-buffer-client';
import type {VideoAccess,VideoBufferProgress} from '../lib/video-buffer-store';
type BufferStatus='preparing'|'buffering'|'retrying'|'partial'|'complete'|'fallback'|'failed';
type Session={source:string|undefined;controller:AbortController;buffer?:VideoBuffer;opening:boolean;unavailable:boolean;fatal:boolean;interrupted:boolean;fallbackPending:boolean;fallbackUsed:boolean;resumePending:boolean};

/** Mounted preview owns its bytes; fallback/recovery never changes the business file entry. */
export function useBufferedVideo(source:string|undefined,signed:string|undefined,expiresAt:number,enabled:boolean,renew:()=>Promise<VideoAccess|null>){
  const [state,setState]=useState<{source:string|undefined;url?:string;status:BufferStatus}>({source,status:'preparing'}),[cycle,setCycle]=useState(0);
  const session=useRef<Session|null>(null);
  const [progress,setProgress]=useState<VideoBufferProgress&{source:string|undefined}>({source,loadedBytes:0,totalBytes:0});
  useEffect(()=>{
    const current:Session={source,controller:new AbortController(),opening:false,unavailable:false,fatal:false,interrupted:false,fallbackPending:false,fallbackUsed:false,resumePending:false};session.current=current;
    return()=>{session.current=null;current.controller.abort();current.buffer?.close();};
  },[source,enabled,cycle]);
  useEffect(()=>{
    const current=session.current;if(!enabled||!current||current.source!==source||current.resumePending)return;
    if(!signed){current.buffer?.close();return;}if(current.unavailable)return;
    const update=(status:BufferStatus,url?:string)=>{if(!current.controller.signal.aborted)setState({source,url,status});};
    if(current.buffer){void current.buffer.renew(signed,expiresAt).catch(()=>update('failed'));return;}
    if(current.opening)return;
    if(!videoBufferSupported()){current.unavailable=true;update('fallback');return;}
    current.opening=true;update('preparing');let initial:BufferStatus='buffering';
    void openVideoBuffer(signed,expiresAt,current.controller.signal,renew,status=>{
      if(status==='failed'){current.fatal=true;current.buffer?.close();update('failed');}
      else if(status==='closed'){if(!current.fallbackPending&&!current.resumePending){current.fatal=true;update('failed');}}
      else {current.interrupted=status==='partial';initial=status;update(status,current.buffer?.url);}
    },next=>{if(!current.controller.signal.aborted)setProgress({source,...next});}).then(buffer=>{
      if(current.controller.signal.aborted){buffer.close();return;}current.buffer=buffer;update(initial,buffer.url);
    }).catch(()=>{if(!current.controller.signal.aborted){current.unavailable=true;update('fallback');}});
  },[source,signed,expiresAt,enabled,renew,cycle]);
  useEffect(()=>{
    if(!enabled)return;
    const restore=(event:PageTransitionEvent)=>{
      const current=session.current;if(!event.persisted||!current||current.resumePending||current.controller.signal.aborted)return;
      current.resumePending=true;current.buffer?.close();setState({source:current.source,status:'preparing'});
      void renew().then(access=>{if(current.controller.signal.aborted)return;if(access)setCycle(value=>value+1);else{current.fatal=true;setState({source:current.source,status:'failed'});}});
    };
    window.addEventListener('pageshow',restore);return()=>window.removeEventListener('pageshow',restore);
  },[enabled,renew]);
  const fallback=state.source===source&&state.status==='fallback';
  useEffect(()=>{
    if(!enabled||!signed||fallback)return;
    const timer=setInterval(()=>void renew(),45000);return()=>clearInterval(timer);
  },[enabled,signed,renew,fallback]);
  const failover=(remember:()=>void)=>{
    const current=session.current;if(current?.fallbackPending)return true;
    if(!enabled||!current?.buffer||current.fatal||current.fallbackUsed||current.controller.signal.aborted)return false;
    current.fallbackPending=true;current.fallbackUsed=true;current.unavailable=true;remember();current.buffer.close();current.buffer=undefined;
    // Reauthorize before changing transport. Never reuse an old signed URL after a denial.
    void renew().then(access=>{if(current.controller.signal.aborted)return;current.fallbackPending=false;if(access&&!current.fatal)setState({source:current.source,status:'fallback'});else{current.fatal=true;setState({source:current.source,status:'failed'});}});
    return true;
  };
  const value=state.source===source?state:{source,status:'preparing' as const};
  const currentProgress=progress.source===source&&!['failed','fallback','preparing'].includes(value.status)?progress:{loadedBytes:0,totalBytes:0};
  return {src:!enabled?signed:value.status==='fallback'?signed:value.url,status:value.status,progress:currentProgress,canContinue:()=>Boolean(session.current?.interrupted&&!session.current.fatal&&!session.current.controller.signal.aborted),fill:()=>session.current?.buffer?.fill(),restart:()=>{const current=session.current;if(!current||current.controller.signal.aborted)return;if(current.buffer&&!current.fatal&&!current.unavailable){current.buffer.fill();return;}current.resumePending=true;current.buffer?.close();setCycle(value=>value+1);},failover};
}
