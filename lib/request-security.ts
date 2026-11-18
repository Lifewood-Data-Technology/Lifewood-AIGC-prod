/** Invalid client input is an invalid session, never a server exception. */
export function readCookie(header: string | null, name: string): string {
  const value = (header ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  if (!value) return "";
  try { return decodeURIComponent(value.slice(name.length + 1)); } catch { return ""; }
}

/** Only passive formats may be displayed on the application's origin. */
export function fileResponsePolicy(mime: string, download: boolean) {
  const normalized = mime.split(";", 1)[0].trim().toLowerCase();
  const passive = new Set([
    "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/quicktime", "video/ogg",
    "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/flac",
    "text/plain", "text/csv", "text/markdown", "application/json",
  ]);
  return {
    contentType: passive.has(normalized) ? normalized : "application/octet-stream",
    disposition: download || !passive.has(normalized) ? "attachment" : "inline",
    csp: "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  };
}

/** Preview controls must never offer formats the file endpoint downloads for safety. */
export function filePreviewKind(mime: string): "image" | "video" | "audio" | "document" | null {
  const policy = fileResponsePolicy(mime, false);
  if (policy.disposition !== "inline") return null;
  if (policy.contentType.startsWith("image/")) return "image";
  if (policy.contentType.startsWith("video/")) return "video";
  if (policy.contentType.startsWith("audio/")) return "audio";
  // Office files, CSV and Markdown are not reliably viewable in a browser tab.
  return ["application/pdf", "text/plain", "application/json"].includes(policy.contentType) ? "document" : null;
}
