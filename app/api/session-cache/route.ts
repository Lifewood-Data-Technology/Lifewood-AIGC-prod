/** Browser cache cleanup is independent of the authentication response. Some
 * browsers defer delivering a Clear-Site-Data response while clearing cache.
 * This endpoint never reads accounts, creates sessions or clears drafts/cookies.
 */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  return new Response(null, { status: 204, headers: {
    "cache-control": "no-store", "clear-site-data": '"cache"',
  } });
}
