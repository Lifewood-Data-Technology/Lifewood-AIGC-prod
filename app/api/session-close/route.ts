import { releaseAccountTab } from "../../../db/backend";
import { readCookie } from "../../../lib/request-security";
import { readBoundedJson } from "../../../lib/security-controls";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403 });
  let proof = request.headers.get("x-lifewood-tab") || "";
  if (!proof) {
    try {
      const body = await readBoundedJson(request, 512) as { tabProof?: unknown };
      if (typeof body?.tabProof === "string") proof = body.tabProof;
    } catch { return new Response(null, { status: 400 }); }
  }
  const closed = await releaseAccountTab(readCookie(request.headers.get("cookie"), "lifewood_session"), proof);
  return new Response(null, { status: closed ? 204 : 401, headers: { "cache-control": "no-store" } });
}
