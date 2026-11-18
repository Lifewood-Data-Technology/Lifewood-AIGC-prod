import { runtimeDeseretIntegrationService } from "../../../db/deseret-integration-runtime";
import { apiError, authenticatedEmail } from "../_auth";
import { MAX_INTEGRATION_BODY_BYTES } from "../../../lib/deseret-integration-contract";
import { boundedUploadRequest } from "../../../lib/upload-security";

export async function GET(request: Request) {
  try {
    return Response.json(await runtimeDeseretIntegrationService().workspace(authenticatedEmail(request), new URL(request.url).searchParams.get("project") || ""), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return apiError(error, "The integration workspace is unavailable."); }
}
export async function POST(request: Request) {
  try {
    const body: unknown = await boundedUploadRequest(request, MAX_INTEGRATION_BODY_BYTES).json();
    return Response.json(await runtimeDeseretIntegrationService().command(authenticatedEmail(request), new URL(request.url).searchParams.get("project") || "", body), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return apiError(error, "The integration action could not be confirmed."); }
}
