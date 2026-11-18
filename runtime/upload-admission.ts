import { readUploadSettings } from "../lib/upload-settings";

// Before the lifecycle middleware clones/parses the form. Per-process memory
// protection complements the database-backed account/site leases in API routes.
let active = 0;
export async function withUploadAdmission(request: Request, handle: (requestId?: string) => Promise<Response>) {
  if (!["/api/production-workspace", "/api/files", "/api/request-documents"].includes(new URL(request.url).pathname) || ["GET", "HEAD", "OPTIONS"].includes(request.method) || !request.headers.get("content-type")?.startsWith("multipart/form-data")) return handle();
  if(process.env.FILE_TRANSFER_MODE==='direct')return Response.json({error:'Refresh this page to use direct file transfers.',code:'DIRECT_TRANSFER_REQUIRED'},{status:409,headers:{'cache-control':'no-store'}});
  if (active >= readUploadSettings().siteConcurrency) return Response.json(
    { error: "The upload server is busy. Please wait.", code: "UPLOAD_BUSY" },
    { status: 429, headers: { "retry-after": "5", "cache-control": "no-store" } });
  active++;
  const requestId=crypto.randomUUID(),started=Date.now();
  console.info({event:"upload.request.admitted",requestId});
  try { const response=await handle(requestId);console.info({event:"upload.request.complete",requestId,status:response.status,durationMs:Date.now()-started});return response; }
  finally { active--; }
}
