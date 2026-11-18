/** Coalesced actor-scoped maintenance, separate from foreground admission. */
// Jobs start one at a time. A job that exceeds `timeoutMs` stops blocking the queue, but its underlying work keeps
// running: its account stays occupied until that work really settles, and at most `unfinishedLimit` underlying
// jobs may be unfinished at once. A timeout is not a cancellation; the storage call may still be in flight.
// Once `accepting` turns false (service shutdown), no request is queued and no job or rerun starts; jobs already
// started stay tracked until they end.
export function createUploadMaintenance(work:(actor:string)=>Promise<unknown>,track:(job:Promise<void>)=>void,timeoutMs=300000,unfinishedLimit=4,accepting:()=>boolean=()=>true){
  const queued=new Set<string>();
  // Accounts whose underlying job has not settled, with a merged request to run once more afterwards.
  const unfinished=new Map<string,{rerun:boolean}>();
  let draining=false;
  const enqueue=(actor:string)=>{
    if(!accepting()||queued.has(actor))return;
    // A full queue defers maintenance, never rejects or duplicates the upload itself.
    if(queued.size>=64)return;
    queued.add(actor);kick();
  };
  const kick=()=>{if(accepting()&&!draining&&queued.size&&unfinished.size<unfinishedLimit){draining=true;track(Promise.resolve().then(drain));}};
  const start=(actor:string)=>{
    const entry={rerun:false};unfinished.set(actor,entry);
    let job:Promise<unknown>;
    try{job=Promise.resolve(work(actor));}catch(error){job=Promise.reject(error);}
    // The underlying job itself is tracked for shutdown, not only the bounded wait below.
    const settled=job.then(()=>{},()=>{}).finally(()=>{
      unfinished.delete(actor);
      // The merged rerun goes back through the capacity-controlled queue.
      if(entry.rerun)enqueue(actor);else kick();
    });
    track(settled);
    return job;
  };
  const drain=async()=>{
    try{
      while(accepting()&&queued.size&&unfinished.size<unfinishedLimit){
        const actor=queued.values().next().value!;queued.delete(actor);
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([start(actor),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Maintenance timed out'),{timedOut:true})),timeoutMs);})]);}
        catch(error){console.warn({event:(error as {timedOut?:boolean}).timedOut?'upload.maintenance.timeout':'upload.maintenance.deferred'});}
        finally{clearTimeout(timer);}
      }
    }finally{draining=false;}
    // Requests that arrived while the last job finished, or a slot freed meanwhile, continue here.
    kick();
  };
  return (actor:string)=>{
    if(!accepting())return;
    const running=unfinished.get(actor);
    if(running){running.rerun=true;return;}
    enqueue(actor);
  };
}
