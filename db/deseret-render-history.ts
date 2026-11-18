import type { Database } from "./database";
import { finalSubmissionEvidenceSql, legacyFinalSubmissionOperation } from "./deseret-final-provenance";
import { liveLogicalFileSql } from "./file-integrity";

type RenderHistory = {
  replacesVersionId?: string;
  sceneVersionId?: string;
  phase?: "storyboard" | "final";
  publishedFinalVersionIds?: string[];
};

// Older releases recorded scenes and finals in the same submissions table.
// A publication identifies older finals. New submissions also record their phase.
const finalVersions = `SELECT pf.id FROM project_files pf JOIN aigc_file_versions version ON version.id=pf.id
  WHERE pf.language_project_id=? AND ${finalSubmissionEvidenceSql}
  UNION SELECT value FROM json_each(?)`;

export async function previousProductionRender(db: Database, taskId: string, history: RenderHistory) {
  let scope = "";
  const params: string[] = [];
  if (history.replacesVersionId || history.phase === "storyboard") {
    const previousId = history.replacesVersionId || history.sceneVersionId;
    if (!previousId) return null;
    scope = " AND f.current_version_id=?";
    params.push(previousId);
  } else if (history.phase === "final") {
    scope = ` AND f.current_version_id IN (${finalVersions})`;
    params.push(taskId, JSON.stringify(history.publishedFinalVersionIds ?? []));
  }
  return db.prepare(`SELECT f.id,f.current_version_id,COALESCE(MAX(v.version_number),0)+1 AS next_version
    FROM aigc_files f JOIN aigc_folders folder ON folder.id=f.folder_id JOIN aigc_file_versions v ON v.file_id=f.id
    WHERE f.language_project_id=? AND folder.folder_code='03.render.video' AND ${liveLogicalFileSql("f")}${scope}
    GROUP BY f.id ORDER BY f.updated_at DESC,f.id LIMIT 1`).bind(taskId,...params).first<Record<string,unknown>>();
}

export async function lastProductionFinal(db: Database, taskId: string, publishedFinalVersionIds?: string[]) {
  if (!publishedFinalVersionIds) return db.prepare("SELECT MAX(submitted_at) AS at FROM production_final_submissions WHERE language_project_id=?")
    .bind(taskId).first<{at: string | null}>();
  return db.prepare(`SELECT MAX(submitted_at) AS at FROM (
    SELECT s.submitted_at FROM production_final_submissions s
    WHERE s.language_project_id=? AND s.final_version_id IN (${finalVersions})
    UNION ALL
    SELECT op.created_at AS submitted_at FROM aigc_file_operations op
    JOIN aigc_file_versions v ON v.file_id=op.file_id AND v.id=op.details
    JOIN aigc_files f ON f.id=v.file_id
    WHERE f.language_project_id=? AND op.operation=?
  ) finals`).bind(taskId, taskId, JSON.stringify(publishedFinalVersionIds), taskId, legacyFinalSubmissionOperation).first<{at: string | null}>();
}
