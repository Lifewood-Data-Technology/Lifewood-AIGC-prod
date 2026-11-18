import { fileTransferRead } from "../../../runtime/file-transfer";
import { cleanupProductionStaging, discardStagedProductionFile, productionUploadStatus, productionWorkspaceData, stageProductionFile, streamStagedProductionFile, submitProductionWorkspace } from "../../../db/production-workspace";
import { uploadDatabase } from "../../../db/backend";
import { acquireUploadLease, boundedUploadRequest, assertProxyFileUpload } from "../../../lib/upload-security";
import { apiError, authenticatedEmail } from "../_auth";
import { readUploadSettings } from "../../../lib/upload-settings";

export async function GET(request: Request) {
  try {
    const email = authenticatedEmail(request), url = new URL(request.url);
    if (url.searchParams.has("file")) return await fileTransferRead(request, () => streamStagedProductionFile(email, url.searchParams.get("file")!, url.searchParams.get("download") === "1", request.headers.get("range"),url.searchParams.get('thumbnail')==='1'));
    if (url.searchParams.has("upload")) return Response.json(await productionUploadStatus(email, url.searchParams.get("task") || "", url.searchParams.get("upload")!), { headers: { "cache-control": "private, no-store" } });
    const limits = readUploadSettings();
    return Response.json({...await productionWorkspaceData(email, url.searchParams.get("task") || ""), uploadPolicy:{concurrency:limits.clientConcurrency,requestTimeoutMs:limits.requestTimeoutMs}}, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return apiError(error, "Task files unavailable."); }
}

export async function POST(request: Request) {
  let release: (() => Promise<void>) | undefined;
  try {
    const email = authenticatedEmail(request);
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      assertProxyFileUpload();
      release = await acquireUploadLease(await uploadDatabase(), email);
      await cleanupProductionStaging(email);
      const started = Date.now();
      const form = await boundedUploadRequest(request, 104 * 1024 * 1024).formData();
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({error: "A file is required."}, {status: 400});
      const id = String(form.get("id") || "");
      console.info({event:"upload.form.parsed",durationMs:Date.now()-started,...(/^[a-f0-9-]{36}$/.test(id)?{fileId:id}:{})});
      return Response.json(await stageProductionFile(email, String(form.get("task") || ""), String(form.get("id") || ""), String(form.get("purpose") || ""), String(form.get("category") || ""), file));
    }
    const body: unknown = await boundedUploadRequest(request, 64 * 1024).json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.values(body).some(value => typeof value !== "string")) return Response.json({error: "Invalid submission."}, {status: 400});
    return Response.json(await submitProductionWorkspace(email, body as Record<string,string>));
  } catch (error) { return apiError(error, "The result is unconfirmed. Refresh to check before retrying."); }
  finally { await release?.().catch(() => console.warn("upload.lease.release_delayed")); }
}

export async function DELETE(request: Request) {
  try {
    const email = authenticatedEmail(request), url = new URL(request.url);
    return Response.json(await discardStagedProductionFile(email, url.searchParams.get("task") || "", url.searchParams.get("file") || ""));
  } catch (error) { return apiError(error, "Temporary file was not discarded."); }
}
