import { MAX_INTEGRATION_BODY_BYTES, parseIntegrationConfig, validateIntegrationEnvelope, verifyIntegrationRequest } from "../../../../lib/deseret-integration-contract";
import { runtimeDeseretIntegrationService } from "../../../../db/deseret-integration-runtime";
import { PublicError } from "../../../../lib/security-controls";
import { apiError } from "../../_auth";

export async function receiveDeseretRequest(request: Request, handoff: boolean) {
  try {
    const config = parseIntegrationConfig();
    if (!config.enabled) throw new PublicError("Deseret integration is disabled.", 503, "DESERET_DISABLED");
    const requestUrl = new URL(request.url);
    const remoteAddress = request.headers.get("x-lifewood-client-ip");
    const localHttp = config.allowLoopbackHttp && process.env.LIFEWOOD_ENV !== "production" && requestUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(requestUrl.hostname) && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress || "");
    if (requestUrl.protocol !== "https:" && !localHttp) throw new PublicError("HTTPS service communication is required.", 400, "INTEGRATION_HTTPS_REQUIRED");
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new PublicError("JSON metadata is required.", 415);
    const reader = request.body?.getReader();
    if (!reader) throw new PublicError("Integration metadata is required.", 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > MAX_INTEGRATION_BODY_BYTES) { await reader.cancel(); throw new PublicError("Integration metadata exceeds the size limit.", 413); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const url = new URL(request.url);
    if (!verifyIntegrationRequest({ headers: request.headers, expectedSender: "deseret", keyId: config.incomingKeyId, secret: config.incomingSecret, method: request.method, pathAndQuery: url.pathname + url.search, body: bytes }))
      throw new PublicError("Service authentication is required.", 401, "INTEGRATION_AUTH_REQUIRED");
    let envelope;
    let body: string;
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); envelope = validateIntegrationEnvelope(JSON.parse(body)); }
    catch { throw new PublicError("Invalid integration event.", 400, "INTEGRATION_INVALID"); }
    if (request.headers.get("x-lw-request-id") !== envelope.eventId || (handoff ? envelope.type !== "project.handoff" : envelope.type === "project.handoff"))
      throw new PublicError("Event identity or route mismatch.", 400, "INTEGRATION_INVALID");
    const service = runtimeDeseretIntegrationService();
    return Response.json(handoff ? await service.handoff(envelope, body) : await service.receive(envelope, body), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof PublicError && error.code === "STALE_RECORD") return Response.json({ error: "The integration state changed. Retry this event.", code: "INTEGRATION_RETRY" }, { status: 503, headers: { "retry-after": "2", "cache-control": "no-store" } });
    return apiError(error, "The integration event could not be applied.");
  }
}
