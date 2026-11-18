import { updateAccountPresence } from "../../../db/backend";
import { readCookie } from "../../../lib/request-security";
import { sessionFailureResponse } from "../../../lib/session-policy";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { active?: unknown; visible?: unknown } | null;
  if (!body || typeof body.active !== "boolean" || typeof body.visible !== "boolean") return Response.json({ error: "Invalid presence update." }, { status: 400 });
  try {
    const ok = await updateAccountPresence(request, readCookie(request.headers.get("cookie"), "lifewood_session"), body.active, body.visible);
    return ok ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : sessionFailureResponse();
  } catch { return Response.json({ error: "Presence service unavailable." }, { status: 503 }); }
}
