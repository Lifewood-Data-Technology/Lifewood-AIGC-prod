/** Browser page memory only; playback, seeks and replay share encoded original bytes. */
import {VideoBlockCache,videoFileLimit} from './video-cache-policy';
import {validateSignedTransferUrl} from './direct-upload-client';
export type VideoAccess={url:string;expiresAt:number};
export type VideoBufferState='buffering'|'retrying'|'complete'|'partial'|'failed';
export type VideoBufferProgress={loadedBytes:number;totalBytes:number};
class TransientVideoRead extends Error {}
export const videoBlockSize=512*1024,videoCacheLimit=videoFileLimit;
export class VideoBufferStore {
  private access:VideoAccess;
  private object:string;
  private size=0;
  private mime='';
  private etag:string|null=null;
  private blocks=new Map<number,Uint8Array>();
  private pending=new Map<number,Promise<Uint8Array>>();
  private queue:Promise<unknown>=Promise.resolve();
  private controller=new AbortController();
  private authorizing:Promise<void>|null=null;
  private filling=false;
  private remainingRetries=0;
  private loadedBytes=0;
  private cache:VideoBlockCache;
  private identity=crypto.randomUUID();
  private focus=0;
  private fillEnabled=false;
  private cacheKey(index:number){return `${this.identity}:${index}`;}
  constructor(access:VideoAccess,private authorize:()=>Promise<VideoAccess|null>,private onState:(state:VideoBufferState)=>void,private onProgress:(progress:VideoBufferProgress)=>void=()=>{},options:{cache?:VideoBlockCache}={}){
    this.cache=options.cache??new VideoBlockCache();
    const url=new URL(validateSignedTransferUrl(access.url));this.object=url.origin+url.pathname;this.access=access;this.renew(access);
  }
  close(){this.controller.abort();this.cache.release(this);this.blocks.clear();this.loadedBytes=0;}
  private assertOpen(){if(this.controller.signal.aborted)throw Error('Closed preview');}
  renew(access:VideoAccess){
    this.assertOpen();const url=new URL(validateSignedTransferUrl(access.url));
    if(url.origin+url.pathname!==this.object||!Number.isFinite(access.expiresAt)||access.expiresAt<=Date.now()||access.expiresAt>Date.now()+120000){this.close();throw Error('Invalid video access');}
    this.access={url:url.href,expiresAt:access.expiresAt};
  }
  async ensureAccess(){
    this.assertOpen();if(Date.now()<this.access.expiresAt-5000)return;
    if(!this.authorizing)this.authorizing=(async()=>{const access=await this.authorize();if(!access)throw Error('Video access denied');this.renew(access);})().finally(()=>{this.authorizing=null;});
    try{await this.authorizing;}catch(error){this.onState('failed');this.close();throw error;}
  }
  async open(){await this.block(0);}
  private readFailure(error:unknown){
    if(!this.controller.signal.aborted){if(error instanceof TransientVideoRead)this.onState('partial');else{this.onState('failed');this.close();}}
  }
  private waitToRetry(milliseconds:number,signal:AbortSignal){
    return new Promise<void>((resolve,reject)=>{
      if(signal.aborted){reject(new TransientVideoRead('Video retry cancelled'));return;}
      const finish=()=>{signal.removeEventListener('abort',cancel);resolve();};
      const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new TransientVideoRead('Video retry cancelled'));};
      const timer=setTimeout(finish,milliseconds);signal.addEventListener('abort',cancel,{once:true});
    });
  }
  private async block(index:number,background=false):Promise<Uint8Array>{
    await this.ensureAccess();if(!background)this.focus=index;const cached=this.blocks.get(index);if(cached){this.cache.touch(this.cacheKey(index));return cached;}
    const existing=this.pending.get(index);if(existing)return existing.catch(error=>{this.readFailure(error);throw error;});
    const pending=this.queue.then(async()=>{
      await this.ensureAccess();const start=index*videoBlockSize,end=this.size?Math.min(start+videoBlockSize-1,this.size-1):start+videoBlockSize-1;
      const controller=new AbortController(),abort=()=>controller.abort();this.controller.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,30000);
      try{
       for(;;){
        try{
        await this.ensureAccess();
        let response:Response;
        try{response=await fetch(this.access.url,{headers:{Range:`bytes=${start}-${end}`},credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});}
        catch{throw new TransientVideoRead('Video network read failed');}
        if(response.status===429||response.status>=500){await response.body?.cancel();throw new TransientVideoRead('Video provider unavailable');}
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||''),size=range?Number(range[3]):0,mime=(response.headers.get('content-type')||'').split(';')[0],etag=response.headers.get('etag');
        if(response.status!==206||!range||Number(range[1])!==start||Number(range[2])!==Math.min(end,size-1)||!Number.isSafeInteger(size)||size<=0||size>videoCacheLimit||!mime.startsWith('video/')||(this.size&&this.size!==size)||(this.mime&&this.mime!==mime)||(this.size>0&&this.etag!==etag)){
          await response.body?.cancel();throw Error('Unsupported video response');
        }
        const expected=Number(range[2])-start+1,bytes=new Uint8Array(expected),reader=response.body?.getReader();if(!reader)throw Error('Missing video body');let offset=0;
        try{for(;;){let part:ReadableStreamReadResult<Uint8Array>;try{part=await reader.read();}catch{throw new TransientVideoRead('Video stream interrupted');}if(part.done)break;if(offset+part.value.byteLength>expected)throw Error('Video range overflow');bytes.set(part.value,offset);offset+=part.value.byteLength;}if(offset!==expected)throw Error('Truncated video range');}
        catch(error){await reader.cancel().catch(()=>{});throw error;}
        this.assertOpen();this.size=size;this.mime=mime;this.etag=etag;this.cache.put(this.cacheKey(index),{owner:this,bytes,priority:index===0||index===Math.ceil(size/videoBlockSize)-1,evicted:()=>{const old=this.blocks.get(index);if(old){this.blocks.delete(index);this.loadedBytes-=old.byteLength;if(!this.controller.signal.aborted){this.onProgress({loadedBytes:this.loadedBytes,totalBytes:this.size});this.onState('buffering');}}}});
        this.blocks.set(index,bytes);this.loadedBytes+=bytes.byteLength;
        this.onProgress({loadedBytes:this.loadedBytes,totalBytes:size});
        if(this.blocks.size===Math.ceil(size/videoBlockSize))this.onState('complete');else if(this.filling)this.onState('buffering');if(!background&&this.fillEnabled&&this.size>this.cache.limit)queueMicrotask(()=>void this.fill());return bytes;
        }catch(error){
          // Retry transient background reads only, never integrity or authorization failures.
          // Two retries per fill share the original block's 30-second deadline.
          if(!background||!(error instanceof TransientVideoRead)||!this.remainingRetries||controller.signal.aborted)throw error;
          const delay=this.remainingRetries===2?500:1500;this.remainingRetries--;this.onState('retrying');await this.waitToRetry(delay,controller.signal);
        }
       }
      }finally{clearTimeout(timer);this.controller.signal.removeEventListener('abort',abort);}
    });
    this.pending.set(index,pending);this.queue=pending.catch(()=>{});
    try{return await pending;}catch(error){this.readFailure(error);throw error;}finally{this.pending.delete(index);}
  }
  async fill(){
    this.fillEnabled=true;
    if(this.filling||this.controller.signal.aborted)return;this.filling=true;this.remainingRetries=2;
    const large=this.size>this.cache.limit,anchor=this.focus,total=Math.ceil(this.size/videoBlockSize);
    // Large files prefetch a bounded forward window, never an entire eviction loop.
    const start=large?anchor:0,end=large?Math.min(total,start+Math.max(1,Math.min(64,Math.floor(this.cache.limit/videoBlockSize)))):total;
    if(this.blocks.size<total)this.onState('buffering');
    try{for(let index=start;index<end;index++){if(large&&this.focus!==anchor)break;await this.block(index,true);}}
    catch{ /* Transient background failure retains cached blocks; integrity/auth failures close them. */ }
    finally{this.filling=false;if(large&&this.focus!==anchor&&!this.controller.signal.aborted)queueMicrotask(()=>void this.fill());}
  }
  async response(header:string|null,method='GET'){
    const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};try{await this.ensureAccess();}catch{return new Response(null,{status:410,headers});}
    if(!['GET','HEAD'].includes(method))return new Response(null,{status:405,headers});
    const match=header?/^bytes=(\d*)-(\d*)$/.exec(header):null;
    const start=!header?0:match?.[1]?Number(match[1]):match?.[2]?Math.max(0,this.size-Number(match[2])):NaN,end=match?.[1]&&match[2]?Math.min(Number(match[2]),this.size-1):this.size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=this.size||end<start)return new Response(null,{status:416,headers:{...headers,'content-range':`bytes */${this.size}`}});
    let position=start,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull:async controller=>{
      try{const index=Math.floor(position/videoBlockSize),block=await this.block(index);if(cancelled)return;const offset=position-index*videoBlockSize,count=Math.min(block.byteLength-offset,end-position+1);
        controller.enqueue(block.slice(offset,offset+count));position+=count;if(position>end)controller.close();
      }catch(error){if(!cancelled)controller.error(error);}
    },cancel(){cancelled=true;}},{highWaterMark:0});
    return new Response(method==='HEAD'?null:stream,{status:header?206:200,headers:{...headers,'content-type':this.mime,'accept-ranges':'bytes','content-length':String(end-start+1),...(header?{'content-range':`bytes ${start}-${end}/${this.size}`}:{})}});
  }
}
