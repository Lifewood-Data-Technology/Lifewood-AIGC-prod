import { getWorkspaceSyncState } from "../../../db/backend";
import { authenticatedEmail } from "../_auth";

export async function GET(request: Request) {
  const state = await getWorkspaceSyncState(authenticatedEmail(request));
  return state
    ? Response.json(state, { headers: { "cache-control": "no-store, max-age=0" } })
    : Response.json({ error: "Workspace is not available." }, { status: 401 });
}
