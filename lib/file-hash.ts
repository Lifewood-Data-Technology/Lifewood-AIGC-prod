import { createHash } from "node:crypto";
import { verifiedUpload } from "../runtime/verified-upload";

/** Do not allocate a second whole-file ArrayBuffer just to calculate a digest. */
export async function hashFile(file: Blob) {
  const verified = verifiedUpload(file);
  if (verified) return verified.sha256;
  const hash = createHash("sha256");
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return hash.digest("hex");
  } finally { reader.releaseLock(); }
}
