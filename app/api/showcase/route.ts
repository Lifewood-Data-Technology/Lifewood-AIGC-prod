import { getPublicShowcase } from "../../../db/backend";

export async function GET() {
  return Response.json({ items: await getPublicShowcase() });
}
