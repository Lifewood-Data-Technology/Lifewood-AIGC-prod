import {getAccount,requireCapability,mutationAuthority} from '../../../../db/backend';
import {previewLogDeletion,executeLogDeletion,readLogDeletionReceipt} from '../../../../db/admin-log-deletion';
import {parseLogDeletionCommand,type LogKind} from '../../../../lib/admin-log-deletion';
import {PublicError,readBoundedJson} from '../../../../lib/security-controls';
import {env} from '../../../../runtime/node-environment';
import {authenticatedEmail,apiError} from '../../_auth';

async function actorFor(request:Request){
  const email=authenticatedEmail(request),actor=await getAccount(email);
  if(!actor||actor.access!=='system')throw new PublicError('Administrator access required.',403);
  return {email,authorize:async(kind:LogKind)=>{
    const current=await getAccount(email);
    if(!current||current.access!=='system')throw new PublicError('Administrator access required.',403);
    const capability=kind==='audit'?'system.manage':'accounts.manage';
    await requireCapability(current,capability);
    return mutationAuthority(env.DB,current,capability);
  }};
}
export async function POST(request:Request){try{
  const actor=await actorFor(request);
  const body=await readBoundedJson(request,1_048_576);
  let command;try{command=parseLogDeletionCommand(body);}catch{throw new PublicError('Invalid log deletion request.',400,'INVALID_LOG_DELETION');}
  const result=command.action==='preview'?await previewLogDeletion(env.DB,actor.email,actor.authorize,command):await executeLogDeletion(env.DB,actor.email,actor.authorize,command);
  return Response.json(result,{headers:{'cache-control':'no-store'}});
}catch(cause){return apiError(cause,'Could not complete log deletion. Verify the original submission before retrying.');}}
export async function GET(request:Request){try{
  const actor=await actorFor(request),params=new URL(request.url).searchParams;
  const kind=params.get('kind');
  if([...params.keys()].some(key=>!['submissionId','kind'].includes(key))||params.getAll('submissionId').length!==1||params.getAll('kind').length!==1||(kind!=='audit'&&kind!=='login'))throw new PublicError('Invalid receipt query.',400);
  return Response.json(await readLogDeletionReceipt(env.DB,actor.email,actor.authorize,params.get('submissionId')||'',kind),{headers:{'cache-control':'no-store'}});
}catch(cause){return apiError(cause,'Could not verify log deletion.');}}
