import { guardAuthenticationRequest, unlockPublicShare } from "../../../../db/backend";
import { PublicError, readBoundedJson } from "../../../../lib/security-controls";
import { safeIp } from "../../../../lib/account-access";
import { apiError } from "../../_auth";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403 });
  try {
    await guardAuthenticationRequest(request, "share");
    const body = await readBoundedJson(request, 2048) as { token?: unknown; password?: unknown };
    if (!body || typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token) || typeof body.password !== "string" || body.password.length > 128) throw new PublicError("Invalid link or password.");
    const unlocked = await unlockPublicShare(body.token, body.password, safeIp(request.headers.get("x-lifewood-client-ip")) || "unknown-edge");
    const maxAge = Math.max(0, Math.floor((Date.parse(String(unlocked.expiresAt)) - Date.now()) / 1000));
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store", "set-cookie": `lifewood_share_session=${unlocked.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}` } });
  } catch (error) {
    if (error instanceof PublicError && error.status === 429) return apiError(error, "Share unavailable.");
    return Response.json({ error: "Invalid link or password." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
