import { directUploads } from "../../../../db/direct-upload";
import { boundedUploadRequest } from "../../../../lib/upload-security";
import { apiError, authenticatedEmail } from "../../_auth";
import { PublicError } from "../../../../lib/security-controls";

const id=(request:Request)=>decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)||'');
export async function GET(request:Request){
  try{const actor=authenticatedEmail(request);return Response.json(await directUploads().status(actor,id(request)),{headers:{'cache-control':'private, no-store'}});}
  catch(error){return apiError(error,'Upload status unavailable.');}
}
export async function POST(request:Request){
  try{
    const actor=authenticatedEmail(request),service=directUploads();
    const body:unknown=await boundedUploadRequest(request,2048).json();
    if(!body||typeof body!=='object'||!('action' in body)||Object.keys(body).some(key=>!(body.action==='part'?['action','slot','number','sha256']:['action']).includes(key)))throw new PublicError('Invalid upload operation.');
    if(body.action==='status')return Response.json(await service.status(actor,id(request)),{headers:{'cache-control':'private, no-store'}});
    if(body.action==='complete')return Response.json(await service.complete(actor,id(request)),{headers:{'cache-control':'private, no-store'}});
    if(body.action==='part'&&'slot' in body&&typeof body.slot==='string'&&'number' in body&&typeof body.number==='number'&&'sha256' in body&&typeof body.sha256==='string')return Response.json(await service.part(actor,id(request),body.slot,body.number,body.sha256),{headers:{'cache-control':'private, no-store'}});
    throw new PublicError('Invalid upload operation.');
  }catch(error){return apiError(error,'Upload outcome unconfirmed. Check the original upload.');}
}
export async function DELETE(request:Request){
  try{const actor=authenticatedEmail(request);return Response.json(await directUploads().cancel(actor,id(request)),{headers:{'cache-control':'private, no-store'}});}
  catch(error){return apiError(error,'Upload cancellation unconfirmed.');}
}
