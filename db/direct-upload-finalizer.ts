import type {Database} from './database';
import type {createDirectUploadService} from './direct-upload-service';
// Same code as the service's backgroundYieldCode. Kept local: this module has no runtime imports, so it also loads
// directly under Node type stripping (the native MySQL regression imports it that way).
const backgroundYieldCode='UPLOAD_BACKGROUND_YIELDED';
const backgroundYieldError=()=>Object.assign(new Error('Background completion yielded to a foreground upload.'),{status:409,code:backgroundYieldCode});
/** Only complete transmitted staging uploads. Never replay a formal form submission or an old copy. */
// Foreground work shares the site-wide verification lock and waits only briefly on it: an upload holding an
// unexpired activity lease, a completion holding its claim, or a completion retrying a busy lock in the last minute.
// While running, the background session itself holds a claim, so the in-flight checks exclude it by id.
const foregroundActive=(excludeOwn=false)=>"EXISTS(SELECT 1 FROM direct_upload_sessions WHERE COALESCE(json_extract(payload_json,'$.fields.scope'),'')<>'automatic-preview' AND expires_at>? AND cleaned_at IS NULL AND ((state IN ('created','uploading') AND lease_expires_at>?) OR (state='verifying' AND ((claim_id IS NOT NULL AND lease_expires_at>?) OR updated_at>?)))"+(excludeOwn?' AND id<>?':'')+")";
const activityValues=()=>{const now=new Date().toISOString();return [now,now,now,new Date(Date.now()-60000).toISOString()];};
export function createUploadFinalizer(db:Database,service:Pick<ReturnType<typeof createDirectUploadService>,'complete'>,options:{pollMs?:number}={}){
  const pollMs=options.pollMs??3000;
  let running=false,cursor='';
  // Polls one at a time (each poll is scheduled only after the previous one ends) and aborts the completion as soon
  // as a foreground upload appears. The returned stop function clears the timer and waits for an in-flight poll.
  const watchForeground=(id:string,controller:AbortController)=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<void>=Promise.resolve();
    const poll=async()=>{
      try{
        const active=await db.prepare('SELECT CASE WHEN '+foregroundActive(true)+' THEN 1 ELSE 0 END AS active').bind(...activityValues(),id).first<{active:number}>();
        if(!stopped&&Number(active?.active))controller.abort(backgroundYieldError());
      }catch{
        // A failed probe does not stop the completion: the registration transaction still checks the foreground.
        console.warn({event:'direct-upload.finalize.probe_failed',sessionId:id});
      }finally{
        if(!stopped&&!controller.signal.aborted)timer=setTimeout(()=>{inFlight=poll();},pollMs);
      }
    };
    timer=setTimeout(()=>{inFlight=poll();},pollMs);
    return async()=>{stopped=true;clearTimeout(timer);await inFlight;};
  };
  return async()=>{
    if(running)return;running=true;
    try{
      const now=new Date().toISOString(),idle=new Date(Date.now()-60000).toISOString();
      // Yield the whole pass; skipping consumes neither the cursor nor any persisted recovery attempt.
      if(Number((await db.prepare('SELECT CASE WHEN '+foregroundActive()+' THEN 1 ELSE 0 END AS active').bind(now,now,now,idle).first<{active:number}>())?.active))return;
      const select=async()=>(await db.prepare("SELECT id,actor_email,registration_id,assets_json,updated_at FROM direct_upload_sessions WHERE state='verifying' AND (claim_id IS NULL OR lease_expires_at<?) AND result_json IS NULL AND cleaned_at IS NULL AND expires_at>? AND updated_at<? AND id>? AND json_extract(payload_json,'$.endpoint')='/api/production-workspace' ORDER BY id LIMIT 10").bind(now,now,idle,cursor).all<{id:string;actor_email:string;registration_id:string;assets_json:string;updated_at:string}>()).results;
      let rows=await select();
      // Wrap within the same pass so the end of the list does not cost a whole idle minute.
      if(!rows.length&&cursor){cursor='';rows=await select();}
      for(const row of rows){
        // Advance past protected/exhausted records as well, so they cannot starve newer work.
        cursor=row.id;
        let assets:{etag?:string;destinations?:{confirmed:boolean;copyProtocol?:string;handle?:string}[]}[];
        try{assets=JSON.parse(row.assets_json);if(!assets.length||assets.some(a=>!a.etag||a.destinations?.some(d=>!d.confirmed&&(d.copyProtocol!=='multipart-receipt-v1'||!d.handle))))continue;}catch{continue;}
        // Persisted bounded attempts survive restarts. No unbounded loop over a broken storage operation.
        const key=`upload-finalize:${row.registration_id}`;
        const permit=await db.prepare("INSERT INTO security_rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<3 RETURNING count").bind(key,Date.now()+7*86400000).first<{count:number}>();
        if(!permit)continue;
        // The same foreground check joins the atomic claim, so an upload starting after selection still wins.
        // After the claim, the watcher yields at safe boundaries and the registration transaction checks once more.
        const controller=new AbortController(),stop=watchForeground(row.id,controller);
        try{const at=new Date().toISOString(),since=new Date(Date.now()-60000).toISOString();await service.complete(row.actor_email,row.id,{sql:"EXISTS(SELECT 1 FROM direct_upload_sessions WHERE id=? AND registration_id=? AND assets_json=? AND updated_at=? AND (claim_id IS NULL OR lease_expires_at<?) AND state='verifying' AND cleaned_at IS NULL) AND NOT "+foregroundActive(),values:[row.id,row.registration_id,row.assets_json,row.updated_at,at,at,at,at,since]},
            {source:'background',signal:controller.signal,foregroundGuard:()=>({sql:'NOT '+foregroundActive(true),values:[...activityValues(),row.id]})});
          console.info({event:'direct-upload.finalize.completed',sessionId:row.id,attempt:permit.count});}
        catch(error){
          const code=(error as {code?:string}).code||'',name=error instanceof Error?error.name:'';
          const busy=['UPLOAD_SESSION_BUSY','UPLOAD_VERIFY_BUSY',backgroundYieldCode].includes(code);
          // Timeouts and dropped connections keep the remaining bounded attempts; anything else stops automation for review.
          const transient=['DIRECT_STORAGE_TIMEOUT','DIRECT_STORAGE_CONTROL_TIMEOUT','ECONNRESET','ETIMEDOUT','ECONNREFUSED','EPIPE','EAI_AGAIN'].includes(code)||['AbortError','TimeoutError'].includes(name);
          if(busy)await db.prepare('UPDATE security_rate_limits SET count=count-1 WHERE key=? AND count>0').bind(key).run();
          else if(!transient)await db.prepare('UPDATE security_rate_limits SET count=3 WHERE key=?').bind(key).run();
          // Codes and error names are fixed identifiers; messages may carry storage details and are not logged.
          console.warn({event:'direct-upload.finalize.deferred',sessionId:row.id,attempt:permit.count,code:code||name||'UNCLASSIFIED',outcome:busy?'busy':transient?'retry':'stopped'});
        }
        finally{await stop();}
        // One candidate per minute keeps foreground completion priority and bounds control traffic.
        break;
      }
    }finally{running=false;}
  };
}
