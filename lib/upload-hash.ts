import {sha256} from '@noble/hashes/sha2.js';
const chunk=8*1024*1024;
// A worker that failed to construct or load is remembered for the page, so later jobs do not keep spawning it.
// It never redirects a job that already runs on its own healthy worker.
let workerUnavailable=false;
type Reply={digest?:unknown;ok?:boolean;error?:boolean}|null;
type Task={part:boolean;step:()=>Promise<void>};
// One digest step computes at a time per page. Steps are bounded 8 MiB reads, so an upload's part digests
// run ahead of another file's whole-file digest; every fifth step still serves a waiting whole-file digest.
const queue:Task[]=[];let active=false,partStreak=0;
function pump(){
  if(active)return;
  const file=queue.findIndex(task=>!task.part),part=queue.findIndex(task=>task.part);
  const index=part>=0&&(partStreak<4||file<0)?part:file;if(index<0)return;
  const task=queue[index];partStreak=task.part?partStreak+1:0;active=true;
  task.step().finally(()=>{active=false;pump();});
}
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
/** Cancellation terminates the job's worker and releases the queue at once. */
export function hashUploadFile(file:Blob,signal?:AbortSignal|null):Promise<string>{
  return new Promise<string>((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    // The job owns its backend. Its worker holds partial digest state for bytes [0, offset); once that worker is
    // abandoned for any reason, the main thread starts again from byte zero.
    let offset=0,worker:Worker|null=null,workerFailed=false,reply:((value:Reply)=>void)|null=null,main:ReturnType<typeof sha256.create>|null=null,settled=false;
    const answer=(value:Reply)=>{const pending=reply;reply=null;pending?.(value);};
    const close=()=>{const current=worker;worker=null;if(current){current.onmessage=null;current.onerror=null;current.onmessageerror=null;current.terminate();}answer(null);};
    const finish=(error:unknown,digest?:string)=>{
      if(settled)return;settled=true;close();signal?.removeEventListener('abort',abort);
      const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);
      if(error)reject(error);else resolve(digest!);
    };
    const abort=()=>finish(signal?.reason||new Error('Upload paused'));
    // Construction, load (CSP, bundling, no module workers) and message decoding failures end this job's worker use.
    const failed=()=>{if(!workerUnavailable)console.warn({event:'upload.hash.worker_unavailable'});workerUnavailable=true;workerFailed=true;answer(null);};
    const send=(message:{file:Blob;start:number;end:number;last:boolean})=>new Promise<Reply>(done=>{
      if(!worker){
        let created:Worker;
        try{created=new Worker(new URL('./upload-hash-worker.ts',import.meta.url),{type:'module'});}catch{failed();done(null);return;}
        worker=created;
        created.onmessage=event=>answer(event.data);
        created.onerror=failed;created.onmessageerror=failed;
      }
      reply=done;worker.postMessage(message);
    });
    const task:Task={part:file.size<=chunk,step:async()=>{
      try{
        if(!main){
          // A page-wide failure seen by another job only stops this job from starting a worker, never from using its own.
          if(!workerFailed&&typeof Worker!=='undefined'&&(worker||!workerUnavailable)){
            const end=Math.min(offset+chunk,file.size),last=end>=file.size,value=await send({file,start:offset,end,last});
            if(settled)return;
            if(!workerFailed){
              if(last&&typeof value?.digest==='string'&&/^[a-f0-9]{64}$/.test(value.digest)){finish(null,value.digest);return;}
              if(!last&&value?.ok){offset=end;return;}
            }
          }
          // Fallback: discard the worker and its partial state, then hash every byte again on the main thread.
          close();offset=0;main=sha256.create();
        }
        if(offset<file.size){main.update(new Uint8Array(await file.slice(offset,offset+chunk).arrayBuffer()));offset+=chunk;}
        if(settled)return;
        if(offset>=file.size){finish(null,hex(main.digest()));return;}
        if(typeof window!=='undefined')await new Promise(resolve=>setTimeout(resolve,0));
      }catch(error){finish(error);}
    }};
    signal?.addEventListener('abort',abort,{once:true});queue.push(task);pump();
  });
}
