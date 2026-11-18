/** Page-owned, volatile video bytes. The service worker is only a native-player Range bridge. */
import {VideoBlockCache,readVideoCacheBudget} from './video-cache-policy';
import {VideoBufferStore,type VideoAccess,type VideoBufferState,type VideoBufferProgress} from './video-buffer-store';
export type VideoBuffer={url:string;renew:(url:string,expiresAt:number)=>Promise<void>;fill:()=>void;close:()=>void};
type Session={store:VideoBufferStore;close:()=>void;readers:Set<()=>void>};
const sessions=new Map<string,Session>();
let pageCache:VideoBlockCache|undefined;
function cache(){if(!pageCache){const raw=document.querySelector('meta[name="lifewood-video-cache-mib"]')?.getAttribute('content');pageCache=new VideoBlockCache(readVideoCacheBudget(raw?{LIFEWOOD_VIDEO_CACHE_MIB:raw}:{}));}return pageCache;}
export function releaseVideoBuffers(){for(const value of [...sessions.values()])value.close();}
async function controller(){
  const container=navigator.serviceWorker,existing=await container.getRegistration('/');
  if(existing&&![existing.active,existing.installing,existing.waiting].some(worker=>worker&&new URL(worker.scriptURL).pathname==='/lifewood-video-worker.js'))throw Error('Existing worker');
  const registration=await container.register('/lifewood-video-worker.js',{scope:'/',updateViaCache:'none'}),target=registration.installing||registration.waiting||registration.active;
  await new Promise<void>((resolve,reject)=>{
    const ready=()=>{if(container.controller&&container.controller===target){clearTimeout(timer);container.removeEventListener('controllerchange',ready);resolve();}};
    const timer=setTimeout(()=>{container.removeEventListener('controllerchange',ready);reject(Error('Worker not controlling page'));},8000);
    container.addEventListener('controllerchange',ready);ready();
  });
}
export function videoBufferSupported(){return typeof window!=='undefined'&&window.isSecureContext&&'serviceWorker' in navigator&&typeof MessageChannel!=='undefined';}
async function respond(event:MessageEvent){
  if(event.data?.kind!=='lifewood-video-read'||!event.source||!('scriptURL' in event.source)||typeof event.source.scriptURL!=='string')return;
  const source=new URL(event.source.scriptURL),port=event.ports[0];
  if(source.origin!==window.location.origin||source.pathname!=='/lifewood-video-worker.js'||!port)return;
  const session=sessions.get(event.data.id);
  if(!session){port.postMessage({status:410});port.close();return;}
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,closed=false,reading=false;
  const close=()=>{if(closed)return;closed=true;session.readers.delete(close);void reader?.cancel().catch(()=>{});port.postMessage({failed:true});port.close();};
  session.readers.add(close);
  try{
    const response=await session.store.response(typeof event.data.range==='string'?event.data.range:null,event.data.method);
    if(closed)return;reader=response.body?.getReader();
    port.onmessage=async event=>{
      if(event.data?.cancel){close();return;}if(!event.data?.pull||reading||closed)return;
      reading=true;
      try{const part=await reader?.read();if(closed)return;if(!part||part.done){port.postMessage({done:true});close();}else{const bytes=part.value.buffer;port.postMessage({bytes},[bytes]);}}
      catch{close();}finally{reading=false;}
    };
    port.postMessage({status:response.status,headers:Object.fromEntries(response.headers)});
    if(!reader){session.readers.delete(close);port.close();}
  }catch{close();}
}
export async function openVideoBuffer(url:string,expiresAt:number,signal:AbortSignal,authorize:()=>Promise<VideoAccess|null>,onState:(state:VideoBufferState|'closed')=>void,onProgress?:(progress:VideoBufferProgress)=>void):Promise<VideoBuffer>{
  if(!videoBufferSupported()||sessions.size>=2)throw Error('Unsupported');
  await controller();if(signal.aborted||sessions.size>=2)throw Error('Cancelled or full');
  const id=crypto.randomUUID(),store=new VideoBufferStore({url,expiresAt},authorize,onState,onProgress,{cache:cache()}),readers=new Set<()=>void>();let closed=false;
  const close=()=>{if(closed)return;closed=true;store.close();sessions.delete(id);for(const closeReader of [...readers])closeReader();signal.removeEventListener('abort',close);window.removeEventListener('pagehide',close);if(!sessions.size)navigator.serviceWorker.removeEventListener('message',respond);onState('closed');};
  if(!sessions.size)navigator.serviceWorker.addEventListener('message',respond);
  sessions.set(id,{store,close,readers});signal.addEventListener('abort',close,{once:true});window.addEventListener('pagehide',close,{once:true});
  try{await store.open();if(closed)throw Error('Cancelled');}catch(error){close();throw error;}
  return {url:`/__lifewood-video/${id}`,close,renew:async(signed,expiry)=>{try{store.renew({url:signed,expiresAt:expiry});}catch(error){close();throw error;}},fill:()=>{void store.fill();}};
}
