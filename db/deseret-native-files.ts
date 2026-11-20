import { finalSubmissionEvidenceSql } from "./deseret-final-provenance";
import type { Database } from "./database";
import type { IntegrationNativeFile, IntegrationProjectContext, NativeFileReadOptions } from "./deseret-integration";
import { liveLogicalFileSql } from "./file-integrity";
import { readMaterialTransferConfig } from "../runtime/deseret-material-transfer";
import { qualityFileVisible } from "../lib/task-file-access";

/**
 * An existing native version that an incoming Deseret material may reuse in one task instead of a new upload.
 * Only a live version in that same task's `02_客户素材` folder (folder code 02, `project_files.directory`
 * '02_客户素材'), in the same project, with the same name, checksum and size qualifies. A same-name, same-SHA
 * working draft elsewhere (for example an unsubmitted version in `03_项目制作`) is never reused: the material is
 * then registered in 02 as usual, so the reviewers who may read 02 can read it.
 */
export async function reusableIncomingVersion(db: Database, projectId: string, taskId: string, material: { name: string; size: number }, checksum: string) {
  return db.prepare(`SELECT version.id,storage.object_key,storage.etag FROM aigc_file_versions version
      JOIN aigc_files logical ON logical.id=version.file_id
      JOIN aigc_folders folder ON folder.id=logical.folder_id
      JOIN project_files pf ON pf.id=version.id
      JOIN language_projects lp ON lp.id=pf.language_project_id
      JOIN aigc_storage_objects storage ON storage.id=version.storage_object_id
    WHERE lp.project_id=? AND lp.id=? AND pf.project_id=? AND logical.language_project_id=?
      AND folder.language_project_id=? AND folder.folder_code='02' AND folder.deleted_at IS NULL AND pf.directory='02_客户素材'
      AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("logical")}
      AND version.original_name=? AND version.checksum_sha256=? AND version.size_bytes=?
    ORDER BY version.created_at DESC LIMIT 1`)
    .bind(projectId, taskId, projectId, taskId, taskId, material.name, checksum, material.size)
    .first<{ id: string; object_key: string; etag: string }>();
}

/**
 * Native file versions of one project that the context's actor may read, scoped in SQL to the project and,
 * for makers and quality reviewers, to their own assigned tasks.
 *
 * Quality reviewers normally see only submitted review versions (status rule). With `incomingMaterials`, the
 * caller passes the exact native copies of Deseret materials (handoff materials, review attachments and
 * revision frames) registered in the `02_客户素材` folder. A reviewer's read is then decided by the same rule
 * as the native read and read-URL endpoint (`streamProjectFile`): `qualityFileVisible` over the version's
 * status, source and folder (`directory`). Without explicit ids this mode returns nothing.
 */
export async function nativeIntegrationFiles(context: IntegrationProjectContext, fileIds?: string[], options: NativeFileReadOptions = {}): Promise<IntegrationNativeFile[]> {
  if (options.incomingMaterials && !fileIds?.length) return [];
  const taskCondition = context.actor.access === "project" ? "1=1" : context.actor.access === "production" ? "lp.editor_email=?" : "lp.reviewer_email=?";
  const rows = (await context.db.prepare(`SELECT pf.id,pf.original_name,pf.language_project_id,pf.size_bytes,pf.mime_type,pf.status,pf.directory,pf.source,
      version.checksum_sha256,version.version_number AS native_version,storage.object_key,storage.etag,storage.bucket_name,storage.endpoint_url,storage.region_name,
      EXISTS(SELECT 1 FROM quality_rounds q WHERE q.file_id=pf.id AND q.result='approved') AS quality_passed,
      ${finalSubmissionEvidenceSql} AS final_submission
    FROM project_files pf JOIN language_projects lp ON lp.id=pf.language_project_id
    JOIN aigc_file_versions version ON version.id=pf.id JOIN aigc_files logical ON logical.id=version.file_id
    JOIN aigc_storage_objects storage ON storage.id=version.storage_object_id
    WHERE pf.project_id=? AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("logical")}
      AND ${taskCondition}${fileIds ? " AND pf.id IN (SELECT value FROM json_each(?))" : ""} ORDER BY final_submission DESC,pf.created_at DESC,pf.id${fileIds ? "" : " LIMIT 500"}`)
    .bind(String(context.project.id), ...(context.actor.access === "project" ? [] : [context.actor.email]), ...(fileIds ? [JSON.stringify([...new Set(fileIds)])] : [])).all<Record<string, unknown>>()).results;
  const profile = readMaterialTransferConfig().aigc;
  const endpoint = (value: unknown) => String(value || "").replace(/\/$/, "");
  const qualityVisible = (row: Record<string, unknown>) => options.incomingMaterials
    // Same inputs as streamProjectFile: the project_files row's status, source and directory.
    ? qualityFileVisible({ status: row.status, source: row.source, directory: row.directory })
    // Review candidates keep the review-status rule only; folder placement does not widen them.
    : qualityFileVisible({ status: row.status, version_status: row.status === "rejected" ? "qc_rejected" : row.status });
  return rows.filter(row => context.actor.access !== "quality" || qualityVisible(row)).map(row => ({
    id: String(row.id), version: Number(row.native_version), name: String(row.original_name), languageTaskId: String(row.language_project_id),
    size: Number(row.size_bytes), mimeType: String(row.mime_type), sha256: String(row.checksum_sha256 || ""),
    finalSubmission: Number(row.final_submission) === 1,
    qualityPassed: Boolean(row.quality_passed) && ["qc_approved", "final", "delivered"].includes(String(row.status)),
    storageReady: Boolean(row.object_key) && String(row.bucket_name) === profile.bucket && endpoint(row.endpoint_url) === endpoint(profile.endpoint) && String(row.region_name) === profile.region,
    objectKey: String(row.object_key), storageProfileId: profile.id, etag: String(row.etag || ""),
  }));
}
