import { getAccountAccessDetails } from "../../../db/backend";
import { authenticatedEmail } from "../_auth";

export async function GET(request: Request) {
  try {
    const target = new URL(request.url).searchParams.get("email");
    return Response.json(await getAccountAccessDetails(authenticatedEmail(request), target ?? undefined), { headers: { "cache-control": "no-store" } });
  } catch {
    // Do not expose SQL, identity-existence or authentication internals.
    return Response.json({ error: "Login information is unavailable or access is not permitted." }, { status: 403, headers: { "cache-control": "no-store" } });
  }
}
