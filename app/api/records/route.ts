export async function POST() {
  return Response.json({ error: "This legacy endpoint has been retired. Use the validated workflow API." }, { status: 410 });
}
