/** Apply to successful pages and early failures, not just JSON handlers. */
export function secureResponse(response: Response, request: Request) {
  const url = new URL(request.url), headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "SAMEORIGIN");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (url.protocol === "https:") headers.set("strict-transport-security", "max-age=15552000");
  let secured = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  if (headers.get("content-type")?.includes("text/html")) {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, "0")).join("");
    const development = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const direct=process.env.FILE_TRANSFER_MODE==='direct';
    const hosts=direct?` https://s3.ap-southeast-1.wasabisys.com https://${process.env.WASABI_BUCKET}.s3.ap-southeast-1.wasabisys.com`:'';
    headers.set("content-security-policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:${hosts}; media-src 'self' blob: data:${hosts}; font-src 'self' data:; connect-src 'self'${hosts}${development ? " ws: wss:" : ""}; frame-src 'self' blob:${hosts}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`);
    headers.set("cache-control", "private, no-store");
    secured = new Response(secured.body, { status: secured.status, statusText: secured.statusText, headers });
    secured = new HTMLRewriter().on("script", { element(element) { element.setAttribute("nonce", nonce); } }).transform(secured);
    if(direct)secured=new HTMLRewriter().on('head',{element(element){element.append('<meta name="lifewood-file-transfer" content="direct">',{html:true});}}).transform(secured);
  }
  return secured;
}
