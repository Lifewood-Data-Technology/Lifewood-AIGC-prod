import { fileTransferRead } from "../../../runtime/file-transfer";
import { streamPublicShare } from "../../../db/backend";
import { readCookie } from "../../../lib/request-security";
import { apiError } from "../_auth";

const cookieName = "lifewood_share_session";
function sessionCookie(request: Request) {
  return readCookie(request.headers.get("cookie"), cookieName);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return await fileTransferRead(request, () => streamPublicShare(url.searchParams.get("token") ?? "", sessionCookie(request), request.headers.get("range")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (["PASSWORD_REQUIRED", "SIMULATED_FILE", "LINK_INVALID", "FILE_NOT_FOUND"].includes(message)) {
      const status = message === "PASSWORD_REQUIRED" ? 401 : message === "SIMULATED_FILE" ? 404 : 410;
      return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
    }
    return apiError(error, "File unavailable.");
  }
}
