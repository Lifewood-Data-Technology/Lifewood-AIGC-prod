import { applyNameTranslation, businessTitle, hasChinese, languageLabel } from "./business-locale";

// Only permission-scoped business text can be translated. Credentials, account
// diagnostics, filenames, storage paths and uploaded documents are excluded.
const collections = ["clients", "projects", "videos", "projectRequests", "projectRequestRevisions", "projectRequestAnalyses", "projectConfirmedAnalyses", "languages", "standards", "quality", "pendingQuality", "customerFeedback", "deliveryRecords", "notifications", "checkpoints", "checkpointDrafts", "handovers", "assetCollections", "publications", "shares"];
const fields = new Set(["description", "requirements", "brief", "notes", "summary", "change_notes", "decision_notes", "supplement_notes", "rejection_reason", "reason", "feedback", "details", "comments", "resolution_notes", "version_note", "body_zh", "body_en", "title_zh", "title_en", "issue", "suggestion", "fix", "text", "note", "modification", "requirement", "issue_description", "fix_suggestion"]);
const jsonFields = new Set(["videos_json", "result_json", "analysis_json", "structured_json", "planning_json", "issues_json", "checklist_json", "requirements_json", "annotations_json"]);
for (const field of ["title", "summary_zh", "summary_en", "risk_notes", "production_progress_note", "completed_work", "pending_work", "next_steps"]) fields.add(field);
export function businessContents(platform: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() && hasChinese(value)) {
      result.add(value);
      if (value.length > 3000) contentChunks(value).filter(hasChinese).forEach(text => result.add(text));
    }
  };
  const walk = (value: unknown, inJson = false) => {
    if (!value || typeof value !== "object") { if (inJson) add(value); return; }
    if (Array.isArray(value)) { value.forEach(item => walk(item, inJson)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (fields.has(key) || (inJson && !/(?:id|code|url|path|file|email)$/i.test(key))) add(child);
      if (jsonFields.has(key) && typeof child === "string") { try { walk(JSON.parse(child), true); } catch { /* Retain invalid originals. */ } }
      else if (child && typeof child === "object") walk(child, inJson);
    }
  };
  for (const key of collections) walk(platform[key]);
  // Notifications interpolate already-localized project/language names. Allow
  // those exact display variants too, without accepting arbitrary client text.
  const rows = (key: string) => (Array.isArray(platform[key]) ? platform[key] : []) as Record<string, unknown>[];
  for (const notification of rows("notifications")) {
    let body = String(notification.body_en || "");
    const project = rows("projects").find(row => row.id === notification.project_id);
    if (project?.name) body = body.split(`“${project.name}”`).join(`“${businessTitle(applyNameTranslation(project, "project", rows("nameTranslations")), "en")}”`);
    const language = rows("languages").find(row => row.id === notification.target_id);
    if (language?.language) body = body.split(String(language.language)).join(languageLabel(language.language_code, language.language, "en"));
    add(body);
  }
  return result;
}

export const contentChunks = (text: string): string[] => text.match(/[\s\S]{1,3000}/g) || [];

export function validContentTranslation(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 24000 || hasChinese(value)) throw new Error("Invalid English translation.");
  return value.trim();
}
