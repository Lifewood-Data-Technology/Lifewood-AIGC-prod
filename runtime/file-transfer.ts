import { AsyncLocalStorage } from "node:async_hooks";
import { fileResponsePolicy } from "../lib/request-security";
import type { WasabiBucket } from "./wasabi";

const metadata = new AsyncLocalStorage<{json:boolean;document:boolean;source:string}>();
export function fileTransferRead(request:Request,read:()=>Promise<Response>){const url=new URL(request.url);return metadata.run({json:url.searchParams.get('access')==='1',document:request.headers.get('sec-fetch-dest')==='document',source:url.pathname+url.search},read);}
export async function signedFileResponse(bucket:WasabiBucket,key:string,name:string,mime:string,download:boolean){
  const policy=fileResponsePolicy(mime,download),context=metadata.getStore();
  const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
  if(context?.document&&!context.json&&policy.disposition==='inline')return new Response(null,{status:302,headers:{...headers,location:`/file-preview?source=${encodeURIComponent(context.source)}`}});
  const url=await bucket.signedRead(key,name,policy.contentType,policy.disposition);
  return context?.json?Response.json({url,expiresAt:Date.now()+60000,name,mimeType:policy.contentType,disposition:policy.disposition},{headers}):new Response(null,{status:302,headers:{...headers,location:url}});
}
