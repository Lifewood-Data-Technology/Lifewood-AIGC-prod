import { translateBusinessContents } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") || 0) > 100000) throw new Error("Translation request is too large.");
    const body = await request.json() as { texts?: unknown };
    return Response.json(await translateBusinessContents(authenticatedEmail(request), body.texts), { headers: { "cache-control": "no-store" } });
  } catch (error) { return apiError(error, "Unable to translate business text."); }
}
