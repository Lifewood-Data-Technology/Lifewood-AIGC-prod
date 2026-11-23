import { randomUUID } from "node:crypto";
import {
  S3Client, HeadObjectCommand, CreateMultipartUploadCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, UploadPartCommand, GetObjectCommand, ListPartsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { signRpc, verifyRpcResponse, RESPONSE_SIGNATURE_HEADER, RPC_PATH } from "../services/deseret-transfer-worker/protocol.mjs";
import { wasabiAgentOptions } from "./wasabi-proxy.ts";
import type { MaterialTransferConfig, MaterialTransferInput, MaterialTransferPlan, MaterialTransferTransport } from "./deseret-material-transfer";

export type RelaySettings = { origin: string; keyId: string; secret: string; allowLoopbackHttp: boolean };
const relayError = (message: string, code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, ...extra });

export function readRelaySettings(env: NodeJS.ProcessEnv = process.env): RelaySettings {
  try {
    const origin = env.LIFEWOOD_DESERET_RELAY_ORIGIN || "", keyId = env.LIFEWOOD_DESERET_RELAY_KEY_ID || "", secret = env.LIFEWOOD_DESERET_RELAY_SECRET || "";
    const flag = env.LIFEWOOD_DESERET_RELAY_ALLOW_LOOPBACK_HTTP || "false";
    if (!["true", "false"].includes(flag)) throw Error("Invalid relay configuration.");
    const allowLoopbackHttp = flag === "true" && env.LIFEWOOD_ENV === "audit";
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(keyId) || Buffer.byteLength(secret) < 32 || secret.length > 4096) throw Error("Invalid relay configuration.");
    // Transfer control has its own secret: never a business-event HMAC or a storage credential.
    const others = [env.LIFEWOOD_DESERET_INTEGRATION_INCOMING_SECRET, env.LIFEWOOD_DESERET_INTEGRATION_OUTGOING_SECRET, env.WASABI_SECRET_ACCESS_KEY];
    if (others.some(value => value && value === secret)) throw Error("Invalid relay configuration.");
    return { origin: url.origin, keyId, secret, allowLoopbackHttp };
  } catch { throw relayError("Relay configuration is incomplete.", "TRANSFER_NOT_CONFIGURED"); }
}

const transientStatuses = [408, 425, 429, 500, 502, 503, 504];
const relayNames = ["NoSuchUpload", "NoSuchKey", "NotFound", "AccessDenied", "PreconditionFailed", "BUSY", "REPLAY"];

export function createRelayRpc(settings: RelaySettings, fetcher: typeof fetch = fetch) {
  return async (job: Record<string, unknown>, signal: AbortSignal) => {
    const body = JSON.stringify(job), id = randomUUID(), timestamp = String(Math.floor(Date.now() / 1000));
    let response: Response;
    try {
      response = await fetcher(settings.origin + RPC_PATH, { method: "POST", redirect: "error", signal, body, headers: {
        "content-type": "application/json", "x-lw-key-id": settings.keyId, "x-lw-request-id": id, "x-lw-timestamp": timestamp,
        "x-lw-signature": signRpc(body, settings, id, timestamp),
      } });
    } catch (error) {
      if (signal.aborted) throw error;
      throw relayError("Relay connection failed.", "TRANSFER_RETRY");
    }
    if (transientStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw relayError("Relay temporarily unavailable.", "TRANSFER_RETRY", { $metadata: { httpStatusCode: response.status } });
    }
    // Unsigned proxy pages (HTML 4xx, including 412) describe the deployment, never storage state: a changed source
    // stops the task permanently, so only the worker's signed answer can report one.
    const statusCode = [400, 401, 403, 404, 412, 413].includes(response.status) ? "TRANSFER_NOT_CONFIGURED" : "TRANSFER_RETRY";
    const acknowledgementError = () => relayError("Relay acknowledgement invalid.", response.ok ? "TRANSFER_RETRY" : statusCode, { $metadata: { httpStatusCode: response.status } });
    const reader = response.body?.getReader();
    if (!reader) throw acknowledgementError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 1024 * 1024) throw acknowledgementError();
        chunks.push(next.value);
      }
    } catch { throw acknowledgementError(); }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    let payload: { requestId?: unknown; result?: unknown; code?: unknown };
    try { payload = JSON.parse(bytes.toString("utf8")); } catch { throw acknowledgementError(); }
    // Only the worker holding this relay secret can bind a response to this request, status and body.
    const signed = verifyRpcResponse(response.headers.get(RESPONSE_SIGNATURE_HEADER), bytes, settings, id, response.status);
    if (!response.ok) {
      const remote = signed && typeof payload?.code === "string" ? payload.code : "";
      const name = relayNames.includes(remote) ? remote : "RELAY_FAILED";
      const code = !signed ? statusCode
        : response.status === 412 || ["SOURCE_SIZE_CHANGED", "PART_INTEGRITY_FAILED", "NoSuchKey", "NotFound"].includes(remote) ? "TRANSFER_SOURCE_CHANGED"
          : ["SOURCE_NOT_AUTHORIZED", "TRANSFER_INTEGRITY_UNAVAILABLE"].includes(remote) ? remote : statusCode;
      throw Object.assign(new Error("Deseret transfer relay rejected the operation."), { name, code, $metadata: { httpStatusCode: response.status } });
    }
    if (!signed) throw relayError("Relay acknowledgement is not signed by the configured worker.", "TRANSFER_NOT_CONFIGURED", { $metadata: { httpStatusCode: response.status } });
    if (payload?.requestId !== id || !payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) throw acknowledgementError();
    // The result shape is validated by each caller against the persisted plan.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return payload.result as any;
  };
}

// This transport sends metadata and narrowly scoped capabilities only. Object
// bytes are read and written by the worker on the Deseret server.
export function createRelayTransport(config: MaterialTransferConfig, input: MaterialTransferInput, plan: MaterialTransferPlan, settings = readRelaySettings(), rpc = createRelayRpc(settings)): MaterialTransferTransport {
  const client = new S3Client({
    endpoint: config.aigc.endpoint, region: config.aigc.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 1,
    // The configured storage proxy applies to AIGC's own storage requests; relay control traffic is direct.
    requestHandler: { ...wasabiAgentOptions(config.httpProxy), connectionTimeout: 10000, socketTimeout: 60000, throwOnRequestTimeout: true },
  });
  const source = { projectId: input.deseretProjectId, sourceRevision: input.sourceRevision, file: input.file };
  const isOwn = (bucket: string | undefined) => {
    if (bucket === config.aigc.bucket) return true;
    if (bucket === config.deseret.bucket) return false;
    throw Error("Unconfigured transfer bucket.");
  };
  const uploadPart: MaterialTransferTransport["copyPart"] = async (value, signal) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(value.CopySourceRange || "");
    if (!match) throw Error("Invalid relay range.");
    const start = Number(match[1]), end = Number(match[2]);
    const parsed = new URL("https://source.invalid/" + value.CopySource);
    const versionId = parsed.searchParams.get("versionId") || undefined;
    const job = { op: "part", direction: input.direction, start, end, totalSize: input.file.size, etag: value.CopySourceIfMatch, uploadId: value.UploadId, partNumber: value.PartNumber };
    if (input.direction === "deseret_to_aigc") {
      if (!isOwn(value.Bucket) || value.Key !== plan.target.objectKey) throw Error("Relay target mismatch.");
      const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: config.aigc.bucket, Key: plan.target.objectKey, UploadId: value.UploadId, PartNumber: value.PartNumber, ContentLength: end - start + 1 }), { expiresIn: 180 });
      return rpc({ ...job, source, key: plan.source.objectKey, peerKey: plan.target.objectKey, versionId, url }, signal);
    }
    if (isOwn(value.Bucket) || value.Key !== plan.target.objectKey) throw Error("Relay target mismatch.");
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: config.aigc.bucket, Key: plan.source.objectKey, VersionId: versionId, Range: value.CopySourceRange, IfMatch: value.CopySourceIfMatch }),
      { expiresIn: 180, signableHeaders: new Set(["range", "if-match"]) });
    return rpc({ ...job, key: plan.target.objectKey, peerKey: plan.source.objectKey, url }, signal);
  };
  return {
    dispose: () => client.destroy(),
    head: (v, s) => isOwn(v.Bucket) ? client.send(new HeadObjectCommand(v), { abortSignal: s }) : rpc({ op: "head", key: v.Key, direction: input.direction, source, versionId: v.VersionId }, s),
    begin: (v, s) => isOwn(v.Bucket) ? client.send(new CreateMultipartUploadCommand(v), { abortSignal: s }) : rpc({ op: "begin", key: v.Key, mimeType: v.ContentType, metadata: v.Metadata }, s),
    complete: (v, s) => isOwn(v.Bucket) ? client.send(new CompleteMultipartUploadCommand(v), { abortSignal: s }) : rpc({ op: "complete", key: v.Key, uploadId: v.UploadId, parts: v.MultipartUpload?.Parts }, s),
    abort: (v, s) => isOwn(v.Bucket) ? client.send(new AbortMultipartUploadCommand(v), { abortSignal: s }) : rpc({ op: "abort", key: v.Key, uploadId: v.UploadId }, s),
    async listParts(v, s) {
      const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
      let marker: string | undefined;
      for (let page = 0; page < 11; page++) {
        const result = isOwn(v.Bucket)
          ? await client.send(new ListPartsCommand({ ...v, PartNumberMarker: marker }), { abortSignal: s })
          : await rpc({ op: "list", key: v.Key, uploadId: v.UploadId, marker }, s);
        for (const item of result.Parts || []) if (Number.isInteger(item.PartNumber) && typeof item.ETag === "string" && Number.isSafeInteger(item.Size)) parts.push(item);
        if (!result.IsTruncated) return parts;
        if (!result.NextPartNumberMarker || result.NextPartNumberMarker === marker) throw Error("Invalid upload part pagination.");
        marker = result.NextPartNumberMarker;
      }
      throw Error("Upload part pagination exceeds limit.");
    },
    copyPart: uploadPart,
  };
}
