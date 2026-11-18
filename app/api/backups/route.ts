import { env } from "../../../runtime/node-environment";
import { getAccount } from "../../../db/backend";
import { authenticatedEmail } from "../_auth";
import { validBackupCommand, type BackupStatus } from "../../../lib/backup-contract";

const noStore = { "cache-control": "no-store" };
const unavailable: BackupStatus = {
  configured: false, provider: "not-configured", restoreConfigured: false,
  sourceLabel: "", targetLabel: "", jobs: [],
};

async function handle(request: Request) {
  try {
    const actor = await getAccount(authenticatedEmail(request));
    if (!actor || actor.access !== "system" || actor.mustChangePassword)
      return Response.json({ error: "ADMIN_REQUIRED" }, { status: 403, headers: noStore });
    const url = new URL(request.url);
    if (request.method === "POST" && request.headers.get("origin") !== url.origin)
      return Response.json({ error: "ORIGIN_REQUIRED" }, { status: 403, headers: noStore });
    const serviceUrl = env.BACKUP_SERVICE_URL;
    const token = env.BACKUP_SERVICE_TOKEN;
    if (!serviceUrl || !token) return Response.json(
      request.method === "GET" ? unavailable : { error: "BACKUP_NOT_CONFIGURED" },
      { status: request.method === "GET" ? 200 : 503, headers: noStore },
    );
    const remote = new URL(serviceUrl);
    if (remote.protocol !== "https:" || remote.username || remote.password || remote.search || remote.hash || token.length < 32)
      throw new Error("INVALID_CONFIGURATION");
    remote.pathname = remote.pathname.replace(/\/$/, "") + "/v1/backups";
    let body: string | undefined;
    if (request.method === "POST") {
      const raw = await request.text();
      if (raw.length > 2048) return Response.json({ error: "INVALID_COMMAND" }, { status: 400, headers: noStore });
      let command: unknown;
      try { command = JSON.parse(raw); } catch { command = null; }
      if (!validBackupCommand(command)) return Response.json({ error: "INVALID_COMMAND" }, { status: 400, headers: noStore });
      body = JSON.stringify(command);
    }
    // The service address and credential come only from server configuration.
    // Never forward arbitrary paths, headers, credentials, or redirect targets.
    const response = await fetch(remote, {
      method: request.method, redirect: "error", signal: AbortSignal.timeout(12_000),
      headers: { authorization: "Bearer " + token, "x-actor-email": actor.email, "x-access-role": "system", "content-type": "application/json" },
      ...(body ? { body } : {}),
    });
    if (![200, 202, 400, 409, 503].includes(response.status)) throw new Error("SERVICE_UNAVAILABLE");
    const data: unknown = await response.json();
    return Response.json(data, { status: response.status, headers: noStore });
  } catch (error) {
    return Response.json({ error: error instanceof Error && error.message === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "BACKUP_SERVICE_UNAVAILABLE" }, { status: error instanceof Error && error.message === "AUTH_REQUIRED" ? 401 : 503, headers: noStore });
  }
}

export const GET = handle;
export const POST = handle;
