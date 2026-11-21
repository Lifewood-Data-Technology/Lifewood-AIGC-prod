import type { Database } from "./database";
import { liveLogicalFileSql } from "./file-integrity";
import { archivedVersionReadableSql } from "./deseret-production-archive";

/** Version-level authorization shared by metadata, previews and downloads. */
export function productionReadableVersionQuery(email:string,versionId="") {
  return {sql:`SELECT v.id FROM aigc_file_versions v
    JOIN aigc_files f ON f.id=v.file_id JOIN project_files pf ON pf.id=v.id
    JOIN aigc_folders folder ON folder.id=f.folder_id
    JOIN language_projects lp ON lp.id=f.language_project_id
    JOIN projects p ON p.id=lp.project_id JOIN clients c ON c.id=p.client_id
    WHERE lp.editor_email=? AND (?='' OR v.id=?) AND c.deleted_at IS NULL AND c.status<>'Disabled'
    AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")}
    AND (v.created_by=? OR EXISTS(WITH RECURSIVE ancestors(id,parent_folder_id,folder_code,language_project_id,depth) AS (
      SELECT id,parent_folder_id,folder_code,language_project_id,0 FROM aigc_folders WHERE id=f.folder_id
      UNION ALL SELECT parent.id,parent.parent_folder_id,parent.folder_code,parent.language_project_id,ancestors.depth+1 FROM aigc_folders parent JOIN ancestors ON parent.id=ancestors.parent_folder_id WHERE ancestors.depth<40
    ) SELECT 1 FROM ancestors WHERE language_project_id=lp.id AND (folder_code='02' OR folder_code LIKE '02.%'))
      OR pf.source='generated-quality-report' OR pf.status='quality_report'
      OR EXISTS(SELECT 1 FROM production_flow_files m JOIN production_flow_events e ON e.id=m.event_id
        WHERE m.file_version_id=v.id AND e.language_project_id=lp.id)
      OR pf.status IN ('pending_qc','qc_approved','rejected','customer_revision_requested','final','delivered','superseded')
      OR EXISTS(SELECT 1 FROM production_checkpoint_files m JOIN handover_records h ON h.checkpoint_id=m.checkpoint_id
        WHERE m.file_version_id=v.id AND h.language_project_id=lp.id AND h.to_user_email=? AND h.status IN ('pending','accepted'))
      OR EXISTS(SELECT 1 FROM production_final_submission_files m JOIN production_final_submissions s ON s.id=m.submission_id
        WHERE m.file_version_id=v.id AND s.language_project_id=lp.id)
      OR ${archivedVersionReadableSql})
    UNION SELECT v.id FROM aigc_file_versions v JOIN aigc_files f ON f.id=v.file_id JOIN project_files pf ON pf.id=v.id JOIN aigc_folders folder ON folder.id=f.folder_id
    WHERE f.source='internal' AND (folder.node_type LIKE 'library%' OR folder.path_cache LIKE '/Asset Library%') AND (?='' OR v.id=?) AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")}`, values:[email,versionId,versionId,email,email,versionId,versionId]};
}
export async function productionReadableVersionIds(db:Database,email:string,versionId="") {
  const query=productionReadableVersionQuery(email,versionId);
  const rows=await db.prepare(query.sql).bind(...query.values).all<{id:string}>();
  return new Set(rows.results.map(row=>row.id));
}
