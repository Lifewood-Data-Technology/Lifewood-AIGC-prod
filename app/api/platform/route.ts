import { getAccount, getPlatformData } from "../../../db/backend";
import { canOpenFileCentre } from "../../../lib/file-dialog-access";
import { authenticatedEmail } from "../_auth";

export async function GET(request: Request) {
  const email=authenticatedEmail(request);
  if(new URL(request.url).searchParams.get("view")==="files") {
    const account=await getAccount(email);
    if(!account||!canOpenFileCentre(account.access)) return Response.json({error:"File centre is available to project managers only."},{status:403});
  }
  const platform = await getPlatformData(email);
  return platform ? Response.json(platform) : Response.json({ error: "Workspace is not available." }, { status: 401 });
}
