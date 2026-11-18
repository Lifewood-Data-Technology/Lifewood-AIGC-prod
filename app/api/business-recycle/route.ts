import { recycledBusiness, mutateBusiness } from "../../../db/business-recycle";
import { authenticatedEmail, apiError } from "../_auth";
import { readBoundedJson } from "../../../lib/security-controls";
export async function GET(request: Request) {
  try { return Response.json({ items: await recycledBusiness(authenticatedEmail(request)) }, {headers:{"cache-control":"no-store"}}); }
  catch(error) { return apiError(error,"Unable to read recycle bin.",403); }
}
export async function POST(request: Request) {
  try { return Response.json(await mutateBusiness(authenticatedEmail(request),await readBoundedJson(request) as Parameters<typeof mutateBusiness>[1])); }
  catch(error) { return apiError(error,"Unable to change record."); }
}
