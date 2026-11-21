import type { Database } from "./database";
import { visibleProjectSql } from "./business-visibility";
import { liveLogicalFileSql } from "./file-integrity";
import type { DeseretHandoverFile } from "../lib/deseret-workspace";

/** A grant to read formal file versions. Never use this query to authorize mutations or publisher events. */
export async function deseretHandoverFiles(db: Database, email: string, projectId: string, filter: { versionId?: string; taskId?: string } = {}) {
  const { versionId, taskId } = filter;
  const rows = await db.prepare(`SELECT task.id AS task_id, v.id, v.version_number, v.original_name, pf.mime_type, pf.size_bytes, f.file_kind, folder.folder_code,
      CASE WHEN owner_task.id=task.id THEN f.current_version_id ELSE v.id END AS browse_version_id
    FROM language_projects task
    JOIN deseret_project_links integration ON integration.id=task.project_id
    JOIN projects p ON p.id=task.project_id
    JOIN clients c ON c.id=p.client_id
    JOIN project_files pf ON pf.project_id=p.id
    JOIN aigc_file_versions v ON v.id=pf.id
    JOIN aigc_files f ON f.id=v.file_id AND f.language_project_id=pf.language_project_id
    JOIN language_projects owner_task ON owner_task.id=f.language_project_id AND owner_task.project_id=p.id
    JOIN aigc_folders folder ON folder.id=f.folder_id AND folder.language_project_id=owner_task.id
    WHERE task.editor_email=? AND p.id=? ${taskId === undefined ? "" : "AND task.id=?"} ${versionId === undefined ? "" : "AND v.id=?"}
      AND ${visibleProjectSql("p")} AND c.status<>'Disabled'
      AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")}
      AND EXISTS (SELECT 1 FROM language_assignment_history h WHERE h.language_project_id=task.id
        AND h.new_editor_email=task.editor_email AND h.previous_editor_email<>'' AND h.previous_editor_email<>task.editor_email
        AND h.id=(SELECT latest.id FROM language_assignment_history latest WHERE latest.language_project_id=task.id
          AND COALESCE(latest.new_editor_email,'')<>COALESCE(latest.previous_editor_email,'') ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM handover_records cancelled WHERE cancelled.language_project_id=task.id
          AND cancelled.from_user_email=h.previous_editor_email AND cancelled.to_user_email=h.new_editor_email
          AND cancelled.created_at=h.created_at AND cancelled.status='cancelled'))
      AND (owner_task.id=task.id
        OR EXISTS (SELECT 1 FROM material_standards ms WHERE ms.scope_type='project' AND ms.project_id=p.id
             AND ms.language_project_id=owner_task.id AND ms.status='current' AND ms.is_current=1
             AND ms.logical_file_id=f.id AND ms.file_version_id=v.id)
        OR EXISTS (SELECT 1 FROM task_material_links ml WHERE ml.language_project_id=task.id
             AND ml.material_file_id=f.id AND ml.material_version_id=v.id))
    ORDER BY task.id, pf.created_at DESC, v.id`)
    .bind(email, projectId, ...(taskId === undefined ? [] : [taskId]), ...(versionId === undefined ? [] : [versionId]))
    .all<{ task_id: string; id: string; version_number: number; original_name: string; mime_type: string; size_bytes: number; file_kind: string; folder_code: string | null; browse_version_id: string | null }>();
  return rows.results.map((row): DeseretHandoverFile => ({
    taskId: row.task_id, id: row.id, version: Number(row.version_number), name: row.original_name, mimeType: row.mime_type,
    size: Number(row.size_bytes), kind: row.file_kind, category: row.folder_code ?? "", currentVersionId: row.browse_version_id ?? row.id, live: true,
  }));
}
