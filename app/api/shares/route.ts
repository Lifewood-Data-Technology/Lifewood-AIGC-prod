import { createShareLink, resolvePublicShare, revokeShareLink } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
import { readCookie } from "../../../lib/request-security";
import { readBoundedJson, PublicError } from "../../../lib/security-controls";

const shareCookieName = "lifewood_share_session";

function shareCookieValue(request: Request) {
  return readCookie(request.headers.get("cookie"), shareCookieName);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (request.headers.has("x-lifewood-share-password")) return Response.json({ error: "Use the secure unlock form." }, { status: 405 });
    const share = await resolvePublicShare(url.searchParams.get("token") ?? "", shareCookieValue(request), true);
    const publicData = share.locked ? { locked: true } : { locked: false, kind: share.kind, projectName: share.projectName,
      clientName: share.clientName, language: share.language, originalName: share.originalName, sizeBytes: share.sizeBytes, expiresAt: share.expiresAt };
    return Response.json(publicData, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const invalid = error instanceof Error && error.message === "LINK_INVALID";
    return Response.json({ error: invalid ? "LINK_INVALID" : "Share unavailable." }, { status: invalid ? 410 : 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as { fileId?: string; kind?: "preview" | "delivery"; expiresInDays?: number; password?: string };
    if (!body || typeof body.fileId !== "string" || body.fileId.length > 96 || (body.password !== undefined && typeof body.password !== "string") || (body.expiresInDays !== undefined && (!Number.isFinite(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 90))) throw new PublicError("Invalid share settings.");
    if (!body.kind || !["preview", "delivery"].includes(body.kind)) return Response.json({ error: "Invalid link type." }, { status: 400 });
    return Response.json(await createShareLink(authenticatedEmail(request), body.fileId ?? "", body.kind, Number(body.expiresInDays ?? 7), body.password));
  } catch (error) {
    return apiError(error, "Share link could not be created.");
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { shareId?: string };
    return Response.json(await revokeShareLink(authenticatedEmail(request), body.shareId ?? ""));
  } catch (error) {
    return apiError(error, "Share link could not be revoked.");
  }
}
