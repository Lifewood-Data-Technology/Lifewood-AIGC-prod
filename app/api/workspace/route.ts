export async function GET() {
  return Response.json({ error: "This legacy endpoint has been retired. Use /api/platform." }, { status: 410 });
}
