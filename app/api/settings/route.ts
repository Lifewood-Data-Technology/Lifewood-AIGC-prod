import { getSystemSettings, updateSystemSettings } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";

export async function GET(request: Request) {
  try {
    return Response.json({ settings: await getSystemSettings(authenticatedEmail(request)) });
  } catch (error) {
    return apiError(error, "Request failed.", 403);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { settings?: Record<string, string> };
    return Response.json(await updateSystemSettings(authenticatedEmail(request), body.settings ?? {}));
  } catch (error) {
    return apiError(error, "Request failed.", 403);
  }
}
