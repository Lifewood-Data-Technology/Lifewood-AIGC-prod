import {sha256} from '@noble/hashes/sha2.js';
// One worker per digest job. The page sends one bounded 8 MiB range per message, so only one chunk is read at a time.
const hash=sha256.create();
self.onmessage=async(event:MessageEvent<{file:Blob;start:number;end:number;last:boolean}>)=>{
  try{const {file,start,end,last}=event.data;if(end>start)hash.update(new Uint8Array(await file.slice(start,end).arrayBuffer()));
    self.postMessage(last?{digest:Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('')}:{ok:true});
  }catch{self.postMessage({error:true});}
};
