import type {Database} from "../db/database";
import {readCookie} from "./request-security";
import {readAccountSession,sessionFailureResponse} from "./session-policy";
import {auditMutationResponse} from "../runtime/audit-request";
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionToken(request: Request) {
  return readCookie(request.headers.get("cookie"), "lifewood_session");
}

function isPublicApi(request: Request, pathname: string) {
  // These exact POST handlers authenticate their raw body with a dedicated
  // service HMAC. Caller-supplied user identity headers are still removed below.
  if (request.method === "POST" && ["/api/integrations/deseret-book/handoffs", "/api/integrations/deseret-book/events"].includes(pathname)) return true;
  // Same-origin cache-only cleanup works after logout; it grants no data access.
  if (pathname === "/api/session-cache") return true;
  // Session-close authenticates its cookie + body proof itself, including beacons.
  if (pathname === "/api/session" || pathname === "/api/session-close" || pathname === "/api/public-file" || pathname === "/api/showcase" || pathname === "/api/shares/unlock") return true;
  return pathname === "/api/shares" && request.method === "GET";
}


export async function authenticatedResponse(request:Request,db:Database,clientIp:string,handle:(request:Request)=>Promise<Response>):Promise<Response>{
 const url=new URL(request.url);
 const origin=request.headers.get("origin");
 if(url.pathname.startsWith("/api/")&&!["GET","HEAD","OPTIONS"].includes(request.method)&&origin&&origin!==url.origin)return Response.json({error:"Cross-origin request rejected."},{status:403});
    const clientHeaders = new Headers(request.headers);
    clientHeaders.delete("x-lifewood-actor-email");
    clientHeaders.delete("x-lifewood-actor-role");
    clientHeaders.set("x-lifewood-client-ip", clientIp);
    if (url.pathname.startsWith("/api/") && !isPublicApi(request, url.pathname)) {
      const token = sessionToken(request);
      let account: Record<string, unknown> | null = null;
      if (token) {
        try {
          const tokenHash = await sha256(token);
          const fileRead = request.method === "GET" && (["/api/files", "/api/request-documents"].includes(url.pathname) || (url.pathname === "/api/production-workspace" && url.searchParams.has("file")));
          const tabHash = fileRead ? undefined : await sha256(request.headers.get("x-lifewood-tab") ?? "");
          const state = await readAccountSession(db, tokenHash, undefined, !["/api/sync", "/api/presence", "/api/account-access", "/api/session-close"].includes(url.pathname), tabHash);
          if (!state.account) return sessionFailureResponse(state.code ?? undefined);
          account = state.account;
        } catch {
          return Response.json({ error: "Authentication is temporarily unavailable." }, { status: 503, headers: { "cache-control": "no-store" } });
        }
      }
      if (!account) return sessionFailureResponse();
      if (account.must_change_password) return Response.json({ error: "Change your temporary password before accessing the workbench.", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403, headers: { "cache-control": "no-store" } });
      clientHeaders.set("x-lifewood-actor-email", String(account.email));
      clientHeaders.set("x-lifewood-actor-role", String(account.access_group));
    }

    // Construct once: rebuilding twice would consume authenticated POST bodies.
    const authenticatedRequest = new Request(request, { headers: clientHeaders });
    const response = await auditMutationResponse(authenticatedRequest, db, handle);
    if (url.pathname.startsWith("/api/")) response.headers.set("cache-control", response.headers.get("cache-control") ?? "no-store");
    return response;
}
