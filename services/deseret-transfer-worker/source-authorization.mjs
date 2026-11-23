import {createHash,createHmac,randomUUID} from 'node:crypto';
const path='/api/integrations/aigc/relay-authorize';
const denied=(code,status)=>Object.assign(new Error(code),{code,status});
export function createSourceAuthorizer(config,fetcher=fetch){
  return async (source,signal)=>{
    if(!source||typeof source.projectId!=='string'||!source.file)throw denied('SOURCE_NOT_AUTHORIZED',403);
    const requestId=randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
    const body=JSON.stringify({...source,requestId});
    if(Buffer.byteLength(body)>16384)throw denied('SOURCE_NOT_AUTHORIZED',403);
    const canonical=['LW-INTEGRATION-V1','relay',config.authKeyId,timestamp,requestId,'POST',path,createHash('sha256').update(body).digest('hex')].join('\n');
    let response;
    try{response=await fetcher(config.authOrigin+path,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),body,headers:{'content-type':'application/json','x-lw-service':'relay','x-lw-key-id':config.authKeyId,'x-lw-timestamp':timestamp,'x-lw-request-id':requestId,'x-lw-signature':createHmac('sha256',config.authSecret).update(canonical).digest('hex')}});}catch{throw denied('AUTHORIZATION_UNAVAILABLE',503);}
    if(!response.ok){await response.body?.cancel();if([400,401,403,413].includes(response.status))throw denied('AUTHORIZATION_NOT_CONFIGURED',401);throw denied(response.status===404?'SOURCE_NOT_AUTHORIZED':'AUTHORIZATION_UNAVAILABLE',response.status===404?403:503);}
    const reader=response.body?.getReader();if(!reader)throw denied('AUTHORIZATION_UNAVAILABLE',503);
    let size=0;const chunks=[];
    try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>4096)throw denied('AUTHORIZATION_UNAVAILABLE',503);chunks.push(item.value);}}
    finally{await reader.cancel().catch(()=>{});}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw denied('AUTHORIZATION_UNAVAILABLE',503);}
    if(result.requestId!==requestId||result.authorized!==true)throw denied('SOURCE_NOT_AUTHORIZED',403);
  };
}
