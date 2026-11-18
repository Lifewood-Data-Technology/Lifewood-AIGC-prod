import { administratorMfa } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
import { readBoundedJson, PublicError } from "../../../lib/security-controls";
import { readCookie } from "../../../lib/request-security";

export async function GET(request: Request) {
  try { return Response.json(await administratorMfa(authenticatedEmail(request))); }
  catch (error) { return apiError(error, "MFA settings are unavailable."); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) throw new PublicError("Cross-origin request rejected.", 403);
    const body = await readBoundedJson(request, 4096) as Record<string, unknown> | null;
    if (!body || !["start", "confirm", "disable", "recovery"].includes(String(body.action)) || typeof body.password !== "string" || body.password.length > 1024 || typeof body.code !== "string" || body.code.length > 64) throw new PublicError("Invalid MFA request.");
    return Response.json(await administratorMfa(authenticatedEmail(request), { action: String(body.action), password: body.password, code: body.code, token: readCookie(request.headers.get("cookie"), "lifewood_session") }));
  } catch (error) { return apiError(error, "MFA change was not completed. Refresh the status before retrying."); }
}
