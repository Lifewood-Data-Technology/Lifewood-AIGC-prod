import { directUploads } from "../../../db/direct-upload";
import { boundedUploadRequest } from "../../../lib/upload-security";
import { apiError, authenticatedEmail } from "../_auth";
import { PublicError } from "../../../lib/security-controls";

export async function GET(request:Request){
  try{
    const actor=authenticatedEmail(request),params=new URL(request.url).searchParams;
    if(params.has('mine')){
      if(params.get('mine')!=='1'||[...params.keys()].some(key=>!['mine','cursor','name','state','id'].includes(key))||[...params.keys()].some(key=>params.getAll(key).length!==1)||(params.get('cursor')||'').length>512)throw new PublicError('Invalid upload selection.');
      return Response.json(await directUploads().listMine(actor,params.get('cursor')||'',{name:params.get('name')||'',state:params.get('state')||'all',id:params.get('id')||''}),{headers:{'cache-control':'private, no-store'}});
    }
    if([...params.keys()].some(key=>!['task','purpose','category'].includes(key))||['task','purpose','category'].some(key=>params.getAll(key).length>1))throw new PublicError('Invalid upload selection.');
    return Response.json(await directUploads().list(actor,params.get('task')||'',params.get('purpose')||'',params.get('category')||''),{headers:{'cache-control':'private, no-store'}});
  }catch(error){return apiError(error,'Unfinished uploads could not be loaded.');}
}

export async function POST(request:Request){
  try{const actor=authenticatedEmail(request);return Response.json(await directUploads().create(actor,await boundedUploadRequest(request,32768).json()),{headers:{'cache-control':'private, no-store'}});}
  catch(error){return apiError(error,'Upload reservation unconfirmed. Check the original upload identity.');}
}
