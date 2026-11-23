import type { Database } from "./database";
import { finalSubmissionEvidenceSql } from "./deseret-final-provenance";
import { isStoryboardFileVersion } from "../lib/deseret-workspace";
import { readDeseretState } from "./deseret-integration";
import { PublicError } from "../lib/security-controls";

/** Only current cuts from this language task participate. A past rejection belongs to its old cut. */
export async function qualityReviewTransition(db: Database, projectId: string, taskId: string, fileId: string, approved: boolean) {
  const link = await db.prepare("SELECT state_json,revision FROM deseret_project_links WHERE id=?")
    .bind(projectId).first<{ state_json: string; revision: number }>();
  const guard = link
    ? { sql: "EXISTS (SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)", values: [projectId, link.revision] }
    : { sql: "NOT EXISTS (SELECT 1 FROM deseret_project_links WHERE id=?)", values: [projectId] };
  const nextStatus = approved ? (link ? "制作中" : "待客户预览") : "质检驳回";
  const state = link && readDeseretState(link);
  if (!state) return { deseret: false, nextStatus, guard, sceneOrder: null };
  const scenes = state.scenes.filter(scene => scene.languageTaskId === taskId);
  const subject = scenes.find(scene => scene.fileVersionId === fileId);
  if (state.stage !== "production" || !subject) {
    // The lead may publish or withdraw an older approved cut while this exact final is still in native QC.
    // A publisher phase change must never reclassify a pending storyboard as a final.
    if (state.stage !== "archived" && !isStoryboardFileVersion(state, fileId)) {
      const evidence = `SELECT 1 FROM project_files pf JOIN aigc_file_versions version ON version.id=pf.id
        WHERE pf.id=? AND pf.project_id=? AND pf.language_project_id=? AND ${finalSubmissionEvidenceSql}`;
      const args = [fileId, projectId, taskId];
      if (await db.prepare(evidence).bind(...args).first())
        return { deseret: true, nextStatus, guard: { sql: `${guard.sql} AND EXISTS (${evidence})`, values: [...guard.values, ...args] }, sceneOrder: null };
    }
    throw new PublicError("This version is no longer awaiting review in this phase.", 409, "DESERET_CONFLICT");
  }
  const siblings = (await db.prepare(`SELECT status FROM project_files WHERE project_id=? AND language_project_id=?
    AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
    .bind(projectId, taskId, JSON.stringify(scenes.filter(scene => scene.fileVersionId !== fileId).map(scene => scene.fileVersionId))).all<{ status: string }>()).results;
  const status = siblings.some(file => file.status === "pending_qc") ? "待质检"
    : !approved || siblings.some(file => file.status === "rejected") ? "质检驳回" : "制作中";
  return { deseret: true, nextStatus: status, guard, sceneOrder: subject.order };
}
