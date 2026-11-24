export type RevisionFrameKind = "image" | "video";

/** Legacy image manifests identify a screenshot by MIME alone. New video references also bind its file extension. */
export function revisionFrameKind(file: { name: string; mimeType?: string }): RevisionFrameKind | null {
  if (file.mimeType === "image/png" || file.mimeType === "image/jpeg") return "image";
  const dot = file.name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = file.name.slice(dot + 1).toLowerCase();
  if (file.mimeType === "video/mp4" && extension === "mp4") return "video";
  if (file.mimeType === "video/quicktime" && extension === "mov") return "video";
  return null;
}
