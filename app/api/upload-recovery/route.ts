import {authenticatedEmail,apiError} from '../_auth';
import {uploadRecoveryAdmin,uploadRecoveryAuthority} from '../../../db/upload-recovery';
import {ownUploadHistory} from '../../../db/unfinished-upload-history';
import {env} from '../../../runtime/node-environment';
import {PublicError,consumeRateLimit,readBoundedJson} from '../../../lib/security-controls';
import {guardedMutation} from '../../../db/mutation-guard';
import {prepareAuditStatement} from '../../../db/audit-write';
import {uploadRecoveryId} from '../../../lib/upload-recovery';
const headers={'cache-control':'private, no-store'};
export async function GET(request:Request){try{
  const operator=authenticatedEmail(request),params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>params.getAll(key).length!==1))throw new PublicError('Invalid upload selection.');
  if(params.has('mine')){
    if(params.get('mine')!=='1'||[...params.keys()].some(key=>!['mine','cursor','id'].includes(key))||(params.get('cursor')||'').length>1024||(params.get('id')||'').length>255)throw new PublicError('Invalid upload selection.');
    await consumeRateLimit(env.DB,'upload-history-read',operator,60,60000);
    return Response.json(await ownUploadHistory(env.DB,operator,params.get('cursor')||'',params.get('id')||''),{headers});
  }
  if([...params.keys()].some(key=>key!=='id')||!uploadRecoveryId.test(params.get('id')||''))throw new PublicError('Enter a valid upload record ID.',400,'UPLOAD_RECOVERY_INVALID_ID');
  await uploadRecoveryAuthority(operator);
  await consumeRateLimit(env.DB,'upload-recovery-review',operator,30,60000);
  const review=await (await uploadRecoveryAdmin()).review(operator,params.get('id')!),authority=await uploadRecoveryAuthority(operator);
  await guardedMutation(env.DB,authority.sql,authority.values,[prepareAuditStatement(env.DB,'INSERT INTO audit_logs (action,actor_email,subject,details,created_at) VALUES (?,?,?,?,?)').bind('admin.upload.reviewed',operator,review.id,JSON.stringify({kind:review.kind,reason:review.reason}),new Date().toISOString())]);
  return Response.json(review,{headers});
}catch(error){return apiError(error,'Upload diagnosis could not be completed.');}}
export async function POST(request:Request){try{
  const operator=authenticatedEmail(request);await uploadRecoveryAuthority(operator);
  const value=await readBoundedJson(request,4096);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new PublicError('Invalid recovery request.');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(key=>!['id','review','checkedAt','confirmation'].includes(key))||['id','review','checkedAt','confirmation'].some(key=>typeof v[key]!=='string')||String(v.id).length>36||String(v.review).length!==64||String(v.checkedAt).length>40||v.confirmation!=='ABANDON')throw new PublicError('Invalid recovery request.');
  await consumeRateLimit(env.DB,'upload-recovery-abandon',operator,10,60000);
  return Response.json(await (await uploadRecoveryAdmin()).abandon(operator,{id:String(v.id),review:String(v.review),checkedAt:String(v.checkedAt),confirmation:String(v.confirmation)}),{headers});
}catch(error){return apiError(error,'Cleanup is unconfirmed. Check this record before retrying.');}}
