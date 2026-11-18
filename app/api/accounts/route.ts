import { changeAccountStatus, createManagedAccount, getManagedAccounts, getSessionAccount, updateManagedAccount, revokeManagedSession } from "../../../db/backend";
import { apiError } from "../_auth";
import { readCookie } from "../../../lib/request-security";
import { readBoundedJson } from "../../../lib/security-controls";

const cookieName = "lifewood_session";

function sessionToken(request: Request) {
  return readCookie(request.headers.get("cookie"), cookieName);
}

async function actorEmail(request: Request) {
  const injectedEmail = request.headers.get("x-lifewood-actor-email");
  if (injectedEmail) return injectedEmail;
  const account = await getSessionAccount(sessionToken(request));
  if (!account) throw new Error("AUTH_REQUIRED");
  return account.email;
}

export async function GET(request: Request) {
  try {
    return Response.json({ accounts: await getManagedAccounts(await actorEmail(request)) });
  } catch (error) {
    return apiError(error, "Request failed.", 403);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readBoundedJson(request) as { targetEmail?: string; expectedRevision?: number; status?: "active" | "disabled"; name?: string; access?: string; password?: string; generatePassword?: boolean; permissions?: Record<string, boolean>; revokeSession?: boolean; reason?: string };
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    const invalidShape = !body || typeof body !== "object" || Array.isArray(body) || typeof body.targetEmail !== "string" || !body.targetEmail.trim() || keys.some(key => !["targetEmail","expectedRevision","status","name","access","password","generatePassword","permissions","revokeSession","reason"].includes(key)) || ("expectedRevision" in body && typeof body.expectedRevision !== "number") || ["name","access","password","reason"].some(key => key in body && typeof body[key as keyof typeof body] !== "string") || ["generatePassword","revokeSession"].some(key => key in body && typeof body[key as keyof typeof body] !== "boolean") || ("permissions" in body && (!body.permissions || typeof body.permissions !== "object" || Array.isArray(body.permissions)));
    if (invalidShape) return Response.json({ error: "Invalid account data." }, { status: 400 });
    if ("status" in body) {
      if (!body.status || !["active", "disabled"].includes(body.status) || keys.some(key => !["targetEmail", "status", "expectedRevision"].includes(key))) return Response.json({ error: "Submit one account operation at a time." }, { status: 400 });
    } else if ("revokeSession" in body) {
      if (body.revokeSession !== true || keys.some(key => !["targetEmail", "revokeSession", "reason"].includes(key))) return Response.json({ error: "Submit one account operation at a time." }, { status: 400 });
    } else {
      const hasChange = (typeof body.name === "string" && Boolean(body.name.trim())) || (typeof body.access === "string" && Boolean(body.access.trim())) || (typeof body.password === "string" && Boolean(body.password)) || body.generatePassword === true || Boolean(body.permissions && Object.keys(body.permissions).length);
      if (
        !hasChange ||
        "reason" in body ||
        body.generatePassword === false ||
        (body.generatePassword === true && "password" in body)
      )
        return Response.json(
          { error: "Invalid account data." },
          { status: 400 },
        );
    }
    const email = await actorEmail(request);
    const targetEmail = body.targetEmail as string;
    if (body.revokeSession === true) return Response.json(await revokeManagedSession(email, targetEmail, body.reason || ""));
    if (body.status) return Response.json(await changeAccountStatus(email, targetEmail, body.status, body.expectedRevision));
    return Response.json(await updateManagedAccount(email, { targetEmail, expectedRevision: body.expectedRevision, name: body.name, access: body.access, password: body.password, generatePassword: body.generatePassword, permissions: body.permissions }));
  } catch (error) {
    return apiError(error, "Request failed.", 403);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as { email?: string; name?: string; access?: string };
    if (!body.email || !body.name || !body.access) return Response.json({ error: "Complete all account fields." }, { status: 400 });
    return Response.json(await createManagedAccount(await actorEmail(request), { email: body.email, name: body.name, access: body.access }));
  } catch (error) {
    return apiError(error, "Account could not be created.", 400);
  }
}
