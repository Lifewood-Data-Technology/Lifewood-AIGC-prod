import { changeOwnPassword, createAccountSession, deleteAccountSession, getAccountSessionState, prepareAccountLoginCookie, recordSessionEvent, guardAuthenticationRequest, restoreAccountTab } from "../../../db/backend";
import { PublicError, readBoundedJson } from "../../../lib/security-controls";
import { apiError } from "../_auth";
import { sessionFailureResponse } from "../../../lib/session-policy";
import { readCookie } from "../../../lib/request-security";
import { observeSessionRequest } from "../../../lib/session-diagnostics";

const cookieName = "lifewood_session";

function cookieValue(request: Request) {
  return readCookie(request.headers.get("cookie"), cookieName);
}

function sessionCookie(request: Request, token: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure}`;
}

export async function GET(request: Request) {
  return observeSessionRequest(request, async phase => {
    const previousProof = request.headers.get("x-lifewood-restore") || "";
    if (previousProof) await restoreAccountTab(cookieValue(request), previousProof, request.headers.get("x-lifewood-tab") || "");
    const { account, code } = await getAccountSessionState(cookieValue(request), phase, request.headers.get("x-lifewood-tab") ?? "");
    return account
      ? Response.json({ account })
      : sessionFailureResponse(code ?? undefined);
  });
}

export async function POST(request: Request) {
  const started = performance.now();
  return observeSessionRequest(request, async phase => {
    let attemptedEmail = "";
    try {
      phase("request-body-read");
      await guardAuthenticationRequest(request, "login");
      const body = await readBoundedJson(request) as { email?: unknown; password?: unknown; mfaCode?: unknown; browserKey?: unknown } | null;
      if (!body || typeof body.email !== "string" || typeof body.password !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) || body.password.length > 1024) return Response.json({ error: "Enter a valid email and password." }, { status: 400 });
      attemptedEmail = body.email.slice(0, 254);
      if (body.mfaCode !== undefined && (typeof body.mfaCode !== "string" || body.mfaCode.length > 64)) return Response.json({ error: "Invalid verification code." }, { status: 400 });
      if (body.browserKey !== undefined && (typeof body.browserKey !== "string" || (body.browserKey !== "" && !/^[a-f0-9]{64}$/.test(body.browserKey)))) return Response.json({ error: "Invalid browser recovery key." }, { status: 400 });
      const session = await createAccountSession(body.email, body.password, phase, request.headers.get("x-lifewood-tab") ?? "", cookieValue(request), typeof body.mfaCode === "string" ? body.mfaCode : "", typeof body.browserKey === "string" ? body.browserKey : "");
      if (!session) {
        await recordSessionEvent(request, attemptedEmail, "failed");
        return Response.json({ error: "The email or password is incorrect, or the account is disabled." }, { status: 401 });
      }
      await recordSessionEvent(request, session.account.email, session.resumed ? "resumed" : "signed_in", session.token, {durationMs: Math.max(0, Math.round(performance.now() - started))});
      // PUT already delivered the HttpOnly cookie. A late POST response must
      // NEVER overwrite the cookie belonging to a newer login/logout cycle.
      return Response.json({ account: session.account }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof PublicError && error.code === "MFA_INVALID")
        await recordSessionEvent(request, attemptedEmail, "failed");
      if (error instanceof Error && ["ACCOUNT_ALREADY_SIGNED_IN", "LOGIN_TEMPORARILY_LOCKED"].includes(error.message))
        await recordSessionEvent(request, attemptedEmail, error.message === "ACCOUNT_ALREADY_SIGNED_IN" ? "blocked" : "locked");
      if (error instanceof Error && error.message === "TAB_PROOF_REQUIRED") return Response.json({ error: "Refresh this page before signing in.", code: "TAB_PROOF_REQUIRED" }, { status: 400 });
      if (error instanceof Error && error.message === "ACCOUNT_ALREADY_SIGNED_IN") return Response.json({ error: "This account is already signed in. Sign out of the original session before signing in here.", code: "ACCOUNT_ALREADY_SIGNED_IN" }, { status: 409, headers: { "cache-control": "no-store" } });
      if (error instanceof Error && error.message === "LOGIN_TEMPORARILY_LOCKED") return Response.json({ error: "Too many failed attempts. Try again in 15 minutes." }, { status: 429, headers: { "retry-after": "900" } });
      if (error instanceof PublicError) return apiError(error, "Sign-in unavailable.");
      throw error;
    }
  });
}

// Establish a recovery cookie BEFORE the password request. A lost POST response
// can then be retried by this browser without creating a second session.
export async function PUT(request: Request) {
  if (!/^[a-f0-9]{64}$/.test(request.headers.get("x-lifewood-tab") ?? ""))
    return Response.json({ error: "Refresh before signing in." }, { status: 400 });
  return observeSessionRequest(request, async () => {
    try {
    await guardAuthenticationRequest(request, "intent");
    const prepared = await prepareAccountLoginCookie(cookieValue(request), request.headers.get("x-lifewood-tab") || "");
    return new Response(null, { status: 204, headers: { ...(prepared.replace ? { "set-cookie": sessionCookie(request, prepared.token, 86400) } : {}), "cache-control": "no-store" } });
    } catch (error) { if (error instanceof PublicError) return apiError(error, "Sign-in unavailable."); throw error; }
  });
}

export async function DELETE(request: Request) {
  return observeSessionRequest(request, async phase => {
    phase("session-delete");
    let email;
    try { email = await deleteAccountSession(cookieValue(request), request.headers.get("x-lifewood-tab") ?? ""); }
    catch (error) { if (error instanceof PublicError) return apiError(error, "Sign-out could not be confirmed."); throw error; }
    if (email) await recordSessionEvent(request, email, "signed_out");
    // Do not clear a shared cookie: a delayed response must not erase a newer login.
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}

export async function PATCH(request: Request) {
  const token = cookieValue(request);
  const { account, code } = await getAccountSessionState(token, undefined, request.headers.get("x-lifewood-tab") ?? "");
  if (!account) return sessionFailureResponse(code ?? undefined);
  try {
    const body = await readBoundedJson(request) as { currentPassword?: string; newPassword?: string };
    if (!body || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.currentPassword.length > 1024 || body.newPassword.length > 1024) throw new PublicError("Invalid password input.");
    const result = await changeOwnPassword(account.email, body.currentPassword ?? "", body.newPassword ?? "");
    return Response.json(result, { headers: { "set-cookie": sessionCookie(request, "", 0), "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error, "Password change failed.");
  }
}
