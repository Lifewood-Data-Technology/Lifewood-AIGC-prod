import { pbkdf2 } from "node:crypto";

/** Node-only asynchronous PBKDF2-HMAC-SHA256. Preserve the existing UTF-8
 * encoding, 32-byte output and work factor; do not occupy the JS event loop.
 */
export async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 600_000)
    throw new RangeError("Unsupported password work factor.");
  const input = new TextEncoder().encode(password);
  const saltCopy = Uint8Array.from(salt);
  let derived: Buffer | undefined;
  try {
    derived = await new Promise<Buffer>((resolve, reject) => {
      pbkdf2(input, saltCopy, iterations, 32, "sha256", (error, result) => error ? reject(error) : resolve(result));
    });
    return derived.toString("hex");
  } finally {
    input.fill(0);
    saltCopy.fill(0);
    derived?.fill(0);
  }
}
