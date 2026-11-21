import { businessDeletionRuntime } from "../../../db/business-deletion-runtime";
import { permanentObjectStore } from "../../../runtime/permanent-object-store";
import { authenticatedEmail, apiError } from "../_auth";
import { readBoundedJson, PublicError } from "../../../lib/security-controls";
import { DeletionBlockedError, type DeletionRequest, type DeletionTarget } from "../../../db/business-deletion";

const service = () => businessDeletionRuntime(permanentObjectStore());
/** Every blocker is returned as metadata so the reviewer can act on each one. */
const failed = (error: unknown, fallback: string) => error instanceof DeletionBlockedError ? Response.json({ error: error.message, code: error.code, blockers: error.blockers }, { status: error.status, headers: { "cache-control": "no-store" } }) : apiError(error, fallback);
export async function GET(request: Request) {
  try {
    const email = authenticatedEmail(request), params = new URL(request.url).searchParams;
    const kind = params.get("kind"), id = params.get("id");
    const kinds: DeletionTarget["kind"][] = ["customer", "project", "video", "language"];
    if (!params.get("job") && (!kinds.includes(kind as DeletionTarget["kind"]) || !id)) throw new PublicError("Select a valid record.");
    const target: DeletionTarget = { kind: (kinds.find(item => item === kind) ?? "customer"), id: id ?? "" };
    const result = params.get("job") ? await service().status(email, params.get("job")!) : await service().preview(email, target);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) { return failed(error, "Unable to review permanent deletion."); }
}
export async function POST(request: Request) {
  try {
    const email = authenticatedEmail(request), value = await readBoundedJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicError("Invalid deletion request.");
    const body = value as Record<string, unknown>;
    let result;
    if (body.operation === "start") {
      if (!["customer", "project", "video", "language"].includes(String(body.kind)) || (body.unlinkShared !== undefined && (!Array.isArray(body.unlinkShared) || body.unlinkShared.length > 200 || body.unlinkShared.some(item => typeof item !== "string"))) || typeof body.id !== "string" || typeof body.submissionId !== "string" || typeof body.revision !== "number" || typeof body.previewHash !== "string" || typeof body.confirmationName !== "string") throw new PublicError("Invalid deletion confirmation.");
      const request: DeletionRequest = { kind: body.kind as DeletionTarget["kind"], id: body.id, ...(Array.isArray(body.unlinkShared) ? { unlinkShared: body.unlinkShared as string[] } : {}), submissionId: body.submissionId, revision: body.revision, previewHash: body.previewHash, confirmationName: body.confirmationName };
      result = await service().start(email, request);
    } else if (body.operation === "resume" && typeof body.jobId === "string") result = await service().resume(email, body.jobId);
    else if (body.operation === "cancel-upload" && typeof body.projectId === "string" && typeof body.uploadId === "string" && typeof body.reviewedUpdatedAt === "string") result = await service().cancelUpload(email, { projectId: body.projectId, uploadId: body.uploadId, reviewedUpdatedAt: body.reviewedUpdatedAt });
    if (!result) throw new PublicError("Unsupported deletion operation.");
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) { return failed(error, "Unable to permanently delete the record."); }
}
