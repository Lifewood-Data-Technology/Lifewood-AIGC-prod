/** Personal categories are task-local; these codes never grant access. */
export const productionFileCategories = [
  { id: "project", code: "03.project", zh: "工程文件", en: "Project files" },
  { id: "script", code: "03.script", zh: "脚本", en: "Scripts" },
  { id: "image", code: "03.image", zh: "图片", en: "Images" },
  { id: "video", code: "03.preview", zh: "视频", en: "Videos" },
  { id: "voice", code: "03.voice", zh: "配音", en: "Voiceovers" },
  { id: "music", code: "03.music", zh: "背景音乐", en: "Background music" },
] as const;
export type ProductionFileCategory = typeof productionFileCategories[number]["id"];
/** UI eligibility only; the server rechecks task, access and version atomically. */
export function canSubmitProductionVideo(file: {id?:unknown;kind?:unknown;staged?:unknown;library?:unknown;currentVersionId?:unknown;category?:unknown;status?:unknown}) {
  return file.kind === "video" && !file.library && (file.staged === true ||
    (file.id === file.currentVersionId && ["available", "rejected", "customer_revision_requested"].includes(String(file.status)) &&
      (file.category === "03.render.video" || productionFileCategories.some(category => category.code === file.category))));
}
/** Read-only grouping; it must never move files or rewrite checkpoint roles. */
export function productionBrowseCategory(file: {category?:string;name:string;mimeType:string}) {
  const explicit = productionFileCategories.find(item => item.code === file.category || item.id === file.category)?.id;
  if (explicit) return explicit;
  if (file.mimeType.startsWith("audio/")) return "audio";
  return suggestedProductionCategory(file.name, file.mimeType) || "other";
}
export function suggestedProductionCategory(name: string, mime: string): ProductionFileCategory | "" {
  if (/\.(zip|7z|rar|prproj|aep|drp|fcpxml|blend|psd|ai)$/i.test(name)) return "project";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  // Sound cannot be reliably classified as narration or music by extension.
  if (mime.startsWith("audio/")) return "";
  if (/\.(pdf|docx?|txt|rtf|md|srt|vtt|csv|xlsx?)$/i.test(name)) return "script";
  return "";
}

export function validProductionCategory(value: string): value is ProductionFileCategory {
  return productionFileCategories.some(category => category.id === value);
}

export function parseProductionFileIds(value: string | undefined, limit = 50): string[] {
  const parsed: unknown = JSON.parse(value || "[]");
  if (!Array.isArray(parsed) || parsed.length > limit || parsed.some(id => typeof id !== "string" || !id.trim() || id.length > 100))
    throw new Error("Invalid production file selection");
  return [...new Set(parsed as string[])];
}
