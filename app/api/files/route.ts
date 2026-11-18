import { fileTransferRead } from "../../../runtime/file-transfer";
import { restoreManagedFile, softDeleteManagedFile, softDeleteProjectFile, streamProjectFile, uploadLibraryFile, uploadLibraryThumbnail, uploadProjectFile } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
import { uploadDatabase } from "../../../db/backend";
import { acquireUploadLease, boundedUploadRequest, assertProxyFileUpload } from "../../../lib/upload-security";

export async function POST(request: Request) {
  let release: (() => Promise<void>) | undefined;
  try {
    const actorEmail = authenticatedEmail(request);
    assertProxyFileUpload();
    release = await acquireUploadLease(await uploadDatabase(), actorEmail);
    const data = await boundedUploadRequest(request, 104 * 1024 * 1024).formData();
    const languageProjectId = String(data.get("languageProjectId") ?? "");
    const directory = String(data.get("directory") ?? "");
    const folderId = String(data.get("folderId") ?? "");
    const logicalFileId = String(data.get("logicalFileId") ?? "");
    const scope = String(data.get("scope") ?? "project");
    const assetName = String(data.get("assetName") ?? "");
    const collectionId = String(data.get("collectionId") ?? "");
    const relationType = String(data.get("relationType") ?? "");
    const thumbnailForVersionId = String(data.get("thumbnailForVersionId") ?? "");
    const forceThumbnail = String(data.get("forceThumbnail") ?? "") === "1";
    let sourceAssetIds: string[] = [];
    try { sourceAssetIds = JSON.parse(String(data.get("sourceAssetIds") ?? "[]")) as string[]; } catch { sourceAssetIds = []; }
    const file = data.get("file");
    if (!(file instanceof File)) return Response.json({ error: "A file is required." }, { status: 400 });
    if (thumbnailForVersionId) return Response.json(await uploadLibraryThumbnail(actorEmail, thumbnailForVersionId, file, forceThumbnail));
    const thumbnail = data.get("thumbnail");
    if (scope === "library") return Response.json(await uploadLibraryFile(actorEmail, folderId, file, assetName || undefined, logicalFileId || undefined, collectionId || undefined, relationType || undefined, thumbnail instanceof File ? thumbnail : undefined));
    return Response.json(await uploadProjectFile(actorEmail, languageProjectId, directory, file, folderId || undefined, logicalFileId || undefined, sourceAssetIds));
  } catch (error) {
    return apiError(error, "Upload failed.");
  } finally {
    await release?.().catch(() => console.warn("upload.lease.release_delayed"));
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return await fileTransferRead(request, () => streamProjectFile(authenticatedEmail(request), url.searchParams.get("id") ?? "", url.searchParams.get("download") === "1", request.headers.get("range"), url.searchParams.get("thumbnail") === "1"));
  } catch (error) {
    return apiError(error, "File unavailable.", 404);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { action?: "restore"; logicalFileId?: string };
    if (body.action !== "restore") return Response.json({ error: "Unsupported file action." }, { status: 400 });
    return Response.json(await restoreManagedFile(authenticatedEmail(request), body.logicalFileId ?? ""));
  } catch (error) {
    return apiError(error, "Restore failed.");
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { fileId?: string; logicalFileId?: string };
    const actorEmail = authenticatedEmail(request);
    return Response.json(body.logicalFileId ? await softDeleteManagedFile(actorEmail, body.logicalFileId) : await softDeleteProjectFile(actorEmail, body.fileId ?? ""));
  } catch (error) {
    return apiError(error, "Delete failed.");
  }
}
