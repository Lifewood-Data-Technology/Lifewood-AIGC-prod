import {workspaceFetch} from "./tab-session";

const encoder=new TextEncoder();
const crcTable=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let bit=0;bit<8;bit++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const header=(length:number)=>new DataView(new ArrayBuffer(length));
/** Stored ZIP entries avoid recompressing videos. Names never become directory paths. */
export async function storedZip(files:{name:string;blob:Blob}[]) {
  if(files.length>65535)throw Error("Too many files for this archive.");
  const parts:BlobPart[]=[],central:BlobPart[]=[],used=new Set<string>();let offset=0,centralSize=0;
  for(const file of files){
    const base=Array.from(file.name,char=>char.charCodeAt(0)<32||char==='/'||char==='\\'?'_':char).join('')||"file";
    let name=base,index=2;while(used.has(name))name=`${index++}-${base}`;used.add(name);
    const bytes=encoder.encode(name);if(bytes.length>65535||file.blob.size+offset>0xffffffff)throw Error("Archive exceeds supported size.");
    let crc=0xffffffff;const reader=file.blob.stream().getReader();
    try{while(true){const {done,value}=await reader.read();if(done)break;for(const byte of value)crc=crcTable[(crc^byte)&255]^(crc>>>8);}}finally{reader.releaseLock();}
    crc=(crc^0xffffffff)>>>0;
    const local=header(30);local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint16(6,0x800,true);local.setUint16(12,33,true);local.setUint32(14,crc,true);local.setUint32(18,file.blob.size,true);local.setUint32(22,file.blob.size,true);local.setUint16(26,bytes.length,true);
    const entry=header(46);entry.setUint32(0,0x02014b50,true);entry.setUint16(4,20,true);entry.setUint16(6,20,true);entry.setUint16(8,0x800,true);entry.setUint16(14,33,true);entry.setUint32(16,crc,true);entry.setUint32(20,file.blob.size,true);entry.setUint32(24,file.blob.size,true);entry.setUint16(28,bytes.length,true);entry.setUint32(42,offset,true);
    parts.push(local.buffer,bytes,file.blob);central.push(entry.buffer,bytes);offset+=30+bytes.length+file.blob.size;centralSize+=46+bytes.length;
  }
  if(offset+centralSize>0xffffffff)throw Error("Archive exceeds supported size.");
  const end=header(22);end.setUint32(0,0x06054b50,true);end.setUint16(8,files.length,true);end.setUint16(10,files.length,true);end.setUint32(12,centralSize,true);end.setUint32(16,offset,true);
  return new Blob([...parts,...central,end.buffer],{type:"application/zip"});
}

export async function downloadFileSet(files:{name:string;url:string}[],filename:string,onProgress:(done:number,total:number)=>void) {
  const entries:{name:string;blob:Blob}[]=[];
  for(const [index,file] of files.entries()){
    // Fetch each exact version through the existing authenticated endpoint. No external URL proxy.
    if(!/^\/api\/(files|request-documents)\?id=/.test(file.url))throw Error("Invalid file URL.");
    const response=await workspaceFetch(file.url,{signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw Error(`File unavailable (${response.status}): ${file.name}`);
    entries.push({name:file.name,blob:await response.blob()});onProgress(index+1,files.length);
  }
  if(!entries.length)return;
  const blob=entries.length===1?entries[0].blob:await storedZip(entries);
  const objectUrl=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=objectUrl;link.download=entries.length===1?entries[0].name:filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);
}
