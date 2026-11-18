import { translateBusinessNames } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { items?: Array<Record<string, unknown>> };
    return Response.json(await translateBusinessNames(authenticatedEmail(request), body.items || []), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error, "Unable to translate names.");
  }
}
