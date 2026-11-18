import { fileTransferRead } from "../../../runtime/file-transfer";
import {
  deleteProjectRequestDocument,
  streamProjectRequestDocument,
  uploadProjectRequestDocument,
} from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
import { uploadDatabase } from "../../../db/backend";
import { acquireUploadLease, boundedUploadRequest, assertProxyFileUpload } from "../../../lib/upload-security";

export async function POST(request: Request) {
  let release: (() => Promise<void>) | undefined;
  try {
    const actorEmail = authenticatedEmail(request);
    assertProxyFileUpload();
    release = await acquireUploadLease(await uploadDatabase(), actorEmail);
    const data = await boundedUploadRequest(request, 26 * 1024 * 1024).formData();
    const requestId = String(data.get("requestId") ?? "");
    const file = data.get("file");
    if (!(file instanceof File))
      return Response.json({ error: "A document is required." }, { status: 400 });
    return Response.json(
      await uploadProjectRequestDocument(
        authenticatedEmail(request),
        requestId,
        file,
      ),
    );
  } catch (error) {
    return apiError(error, "Requirement document upload failed.");
  } finally {
    await release?.().catch(() => console.warn("upload.lease.release_delayed"));
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return await fileTransferRead(request, () => streamProjectRequestDocument(
      authenticatedEmail(request),
      url.searchParams.get("id") ?? "",
      url.searchParams.get("download") === "1",
      request.headers.get("range"),
    ));
  } catch (error) {
    return apiError(error, "Requirement document unavailable.", 404);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { documentId?: string };
    return Response.json(
      await deleteProjectRequestDocument(
        authenticatedEmail(request),
        body.documentId ?? "",
      ),
    );
  } catch (error) {
    return apiError(error, "Requirement document removal failed.");
  }
}
