/* Stateless Range bridge. Encoded video bytes live only in the owning page. */
const prefix='/__lifewood-video/';
async function media(event,id){
  const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
  const client=event.clientId&&await self.clients.get(event.clientId);
  if(!client||new URL(client.url).origin!==self.location.origin||!/^[a-zA-Z0-9-]{32,80}$/.test(id))return new Response(null,{status:410,headers});
  if(!['GET','HEAD'].includes(event.request.method))return new Response(null,{status:405,headers});
  const channel=new MessageChannel();
  try{
    const metadata=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Preview unavailable')),35000);
      channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
      client.postMessage({kind:'lifewood-video-read',id,range:event.request.headers.get('range'),method:event.request.method},[channel.port2]);
    });
    if(!metadata||!Number.isInteger(metadata.status)||![200,206,405,410,416].includes(metadata.status))throw Error('Invalid preview response');
    const selected=new Headers(headers);
    for(const key of ['content-type','content-length','content-range','accept-ranges'])if(typeof metadata.headers?.[key]==='string')selected.set(key,metadata.headers[key]);
    if(metadata.status>=400||event.request.method==='HEAD'){channel.port1.close();return new Response(null,{status:metadata.status,headers:selected});}
    let cancelled=false,pullTimer,finishPull;
    const stream=new ReadableStream({pull:controller=>new Promise(resolve=>{
      finishPull=resolve;pullTimer=setTimeout(()=>{if(!cancelled)controller.error(Error('Preview stalled'));channel.port1.close();resolve();},35000);
      channel.port1.onmessage=event=>{
        clearTimeout(pullTimer);if(cancelled){resolve();return;}
        const part=event.data;
        if(part?.bytes instanceof ArrayBuffer&&part.bytes.byteLength>0&&part.bytes.byteLength<=512*1024)controller.enqueue(new Uint8Array(part.bytes));
        else if(part?.done){controller.close();channel.port1.close();}
        else{controller.error(Error('Preview unavailable'));channel.port1.close();}
        resolve();
      };
      channel.port1.postMessage({pull:true});
    }),cancel(){cancelled=true;clearTimeout(pullTimer);finishPull?.();channel.port1.postMessage({cancel:true});channel.port1.close();}},{highWaterMark:0});
    return new Response(stream,{status:metadata.status,headers:selected});
  }catch{channel.port1.close();return new Response(null,{status:410,headers});}
}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin===self.location.origin&&url.pathname.startsWith(prefix))event.respondWith(media(event,url.pathname.slice(prefix.length)));});
