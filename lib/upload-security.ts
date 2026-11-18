import type { Database } from "../db/database";
import { consumeRateLimit, PublicError, securityDigest } from "./security-controls";
import { readUploadSettings } from "./upload-settings";

export function assertProxyFileUpload() {
  if(process.env.FILE_TRANSFER_MODE==='direct')throw new PublicError('Refresh this page to use direct file transfers.',409,'DIRECT_TRANSFER_REQUIRED');
}

/** Bound bytes before multipart parsing, including chunked requests. */
export function boundedUploadRequest(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PublicError("Upload request is too large.", 413, "UPLOAD_TOO_LARGE");
  if (!request.body) throw new PublicError("A file is required.");
  let bytes = 0;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new PublicError("Upload request is too large.", 413, "UPLOAD_TOO_LARGE");
      controller.enqueue(chunk);
    },
  }));
  return new Request(request.url, { method: request.method, headers: request.headers, body, duplex: "half" } as RequestInit);
}

/** Limit accepted work before multipart parsing. Leases expire after crashes. */
export async function acquireUploadLease(db: Database, email: string) {
  const limits = readUploadSettings();
  await consumeRateLimit(db, "upload-rate", email, 120, 60_000);
  const keys = [`upload-active:${await securityDigest(email)}`, "upload-active:site"];
  const acquired: Array<{ key: string; expiry: number }> = [];
  const release = async () => {
    for (const { key, expiry } of acquired) await db.prepare("UPDATE security_rate_limits SET count = MAX(0, count - 1) WHERE key = ? AND expires_at = ?").bind(key, expiry).run();
  };
  try {
    for (let index = 0; index < keys.length; index++) {
      const now = Date.now(), expiry = now + 15 * 60_000;
      const result = await db.prepare(`INSERT INTO security_rate_limits (key, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
        expires_at = CASE WHEN count = 0 OR expires_at <= ? THEN excluded.expires_at ELSE expires_at END
        WHERE expires_at <= ? OR count < ? RETURNING expires_at`)
        .bind(keys[index], expiry, now, now, now, index === 0 ? limits.accountConcurrency : limits.siteConcurrency).first<{ expires_at: number }>();
      if (!result) throw new PublicError("The upload server is busy. Please wait.", 429, "UPLOAD_BUSY");
      acquired.push({ key: keys[index], expiry: result.expires_at });
    }
    return release;
  } catch (error) { await release(); throw error; }
}
