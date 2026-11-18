import { finalSubmissionEvidenceSql } from "./deseret-final-provenance";
import { createDeseretIntegrationService, type IntegrationNativeFile, type IntegrationProjectContext } from "./deseret-integration";
import { deseretProjectContext, deseretServiceProjectContext, projectSummaryUpdateStatement, productionStagingBucket, runWorkflowAction, workflowSubmissionDatabase } from "./backend";
import { parseIntegrationConfig } from "../lib/deseret-integration-contract";
import { readMaterialTransferConfig } from "../runtime/deseret-material-transfer";
import { PublicError } from "../lib/security-controls";
import { liveLogicalFileSql } from "./file-integrity";
import { qualityFileVisible } from "../lib/task-file-access";

export async function nativeIntegrationFiles(context: IntegrationProjectContext, fileIds?: string[]): Promise<IntegrationNativeFile[]> {
  const taskCondition = context.actor.access === "project" ? "1=1" : context.actor.access === "production" ? "lp.editor_email=?" : "lp.reviewer_email=?";
  const rows = (await context.db.prepare(`SELECT pf.id,pf.original_name,pf.language_project_id,pf.size_bytes,pf.mime_type,pf.status,
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
  return rows.filter(row => context.actor.access !== "quality" || qualityFileVisible({ ...row, version_status: row.status === "rejected" ? "qc_rejected" : row.status })).map(row => ({
    id: String(row.id), version: Number(row.native_version), name: String(row.original_name), languageTaskId: String(row.language_project_id),
    size: Number(row.size_bytes), mimeType: String(row.mime_type), sha256: String(row.checksum_sha256 || ""),
    finalSubmission: Number(row.final_submission) === 1,
    qualityPassed: Boolean(row.quality_passed) && ["qc_approved", "final", "delivered"].includes(String(row.status)),
    storageReady: Boolean(row.object_key) && String(row.bucket_name) === profile.bucket && endpoint(row.endpoint_url) === endpoint(profile.endpoint) && String(row.region_name) === profile.region,
    objectKey: String(row.object_key), storageProfileId: profile.id, etag: String(row.etag || ""),
  }));
}

export function runtimeDeseretIntegrationService() {
  const config = parseIntegrationConfig();
  if (!config.enabled) throw new PublicError("Deseret integration is disabled.", 503, "DESERET_DISABLED");
  return createDeseretIntegrationService({
    db: workflowSubmissionDatabase(), config,
    createNativeProject: (payload, commit) => runWorkflowAction(config.intakeOwnerEmail, "project.create", payload, undefined, commit),
    async projectContext(email, projectId, write) {
      const context = await deseretProjectContext(email, projectId);
      if (!write) return context;
      return deseretProjectContext(email, projectId, context.actor.access === "production" ? "files.upload" : "projects.manage");
    },
    serviceProjectContext: projectId => deseretServiceProjectContext(projectId),
    nativeFiles: nativeIntegrationFiles,
    projectSummaryStatement: projectId => projectSummaryUpdateStatement(workflowSubmissionDatabase(), projectId),
    async verifyNativeFiles(files) {
      for (const file of files) {
        if (!/^(?:[a-f0-9]{64}|wasabi-sha256-parts-v1:[a-f0-9]{64})$/.test(file.sha256))
          throw new PublicError("This file requires a verified integrity record before publication.", 409, "DESERET_INTEGRITY_REQUIRED");
        const head = await productionStagingBucket().head(file.objectKey);
        if (!head || head.size !== file.size || !file.etag || head.etag.replaceAll('"', "") !== file.etag.replaceAll('"', ""))
          throw new PublicError("A registered review object changed or is unavailable.", 409, "DESERET_OBJECT_UNAVAILABLE");
      }
    },
  });
}
