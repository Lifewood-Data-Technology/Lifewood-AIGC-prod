import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("LWBACK01");
export type Digest = { sha256: string; bytes: number };
export function meter() {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({ transform(chunk: Buffer, _encoding, next) {
    bytes += chunk.length; hash.update(chunk); next(null, chunk);
  } });
  return { stream, result: (): Digest => ({ sha256: hash.digest("hex"), bytes }) };
}
export const sink = () => new Writable({ write(_chunk, _encoding, next) { next(); } });

/** Constant-memory envelope: magic (8) + IV (12) + ciphertext + GCM tag (16). */
export async function seal(input: Readable, path: string, key: Buffer): Promise<Digest> {
  const iv = randomBytes(12);
  const file = await open(path, "wx", 0o600);
  try { await file.write(Buffer.concat([magic, iv])); } finally { await file.close(); }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(magic);
  const digest = meter();
  await pipeline(input, digest.stream, cipher, createWriteStream(path, { flags: "a", mode: 0o600 }));
  await appendFile(path, cipher.getAuthTag());
  return digest.result();
}

export async function unseal(path: string, key: Buffer): Promise<Readable> {
  const file = await open(path, "r");
  let size: number;
  const header = Buffer.alloc(20);
  const tag = Buffer.alloc(16);
  try {
    size = (await file.stat()).size;
    if (size < 36) throw new Error("ARCHIVE_INVALID");
    await file.read(header, 0, 20, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally { await file.close(); }
  if (!header.subarray(0, 8).equals(magic)) throw new Error("ARCHIVE_INVALID");
  const cipher = createDecipheriv("aes-256-gcm", key, header.subarray(8));
  cipher.setAAD(magic); cipher.setAuthTag(tag);
  const input = size === 36 ? Readable.from([]) : createReadStream(path, { start: 20, end: size - 17 });
  const output = new Transform({ transform(chunk, _encoding, next) { next(null, chunk); } });
  void pipeline(input, cipher, output).catch(error => output.destroy(error as Error));
  return output;
}

export async function inspect(path: string, key: Buffer): Promise<Digest> {
  const digest = meter();
  await pipeline(await unseal(path, key), digest.stream, sink());
  return digest.result();
}

export async function readManifest(path: string, key: Buffer): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await unseal(path, key)) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 32 * 1024 * 1024) throw new Error("MANIFEST_TOO_LARGE");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
