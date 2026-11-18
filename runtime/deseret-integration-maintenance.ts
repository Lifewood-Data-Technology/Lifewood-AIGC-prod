import { createHash } from "node:crypto";
import { createDeseretIntegrationJobs, startDeseretIntegrationScheduler } from "../db/deseret-integration-jobs";
import { deseretServiceProjectContext, productionStagingBucket, uploadProjectFile, workflowSubmissionDatabase } from "../db/backend";
import { businessScopes, withBusinessOperation } from "../db/business-deletion";
import { guardedMutation } from "../db/mutation-guard";
import { parseIntegrationConfig, resolveIntegrationEndpoint, signIntegrationRequest, type HandoffMaterial } from "../lib/deseret-integration-contract";
import { createDeseretMaterialTransfer, readMaterialTransferConfig } from "./deseret-material-transfer";
import { nativeIntegrationFiles } from "../db/deseret-integration-runtime";
import { storedUploadFile } from "./verified-upload";
import { waitUntil, shuttingDown } from "./node-environment";
import { PublicError } from "../lib/security-controls";

function stableId(value: string) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
export function startDeseretIntegrationMaintenance() {
  const config = parseIntegrationConfig();
  if (!config.enabled) return () => {};
  const db = workflowSubmissionDatabase();
  const transfer = createDeseretMaterialTransfer();
  const jobs = createDeseretIntegrationJobs({
    db,
    async projectAuthority(projectId) { return (await deseretServiceProjectContext(projectId, "projects.manage")).access; },
    planTransfer: input => transfer.planTransfer(input),
    transferFile: (input, plan) => transfer.transferFile(input, plan),
    async sourceReceipt(projectId, file) {
      const context = await deseretServiceProjectContext(projectId, "projects.manage");
      const native = (await nativeIntegrationFiles(context, [file.id])).find(item => item.id === file.id);
      if (!native || !native.etag || native.objectKey !== file.objectKey || native.size !== file.size)
        throw new PublicError("The native review source is unavailable.", 409, "TRANSFER_SOURCE_CHANGED");
      if (!/^(?:[a-f0-9]{64}|wasabi-sha256-parts-v1:[a-f0-9]{64})$/.test(native.sha256)) throw new PublicError("Native integrity is unavailable.", 409, "TRANSFER_INTEGRITY_UNAVAILABLE");
      return {
        etag: native.etag, size: native.size,
        integrity: native.sha256.startsWith("wasabi-sha256-parts-v1:") ? { algorithm: "wasabi-sha256-parts-v1", value: native.sha256.slice("wasabi-sha256-parts-v1:".length) } : { algorithm: "sha256", value: native.sha256 },
      };
    },
    async registerIncoming(projectId, jobId, material: HandoffMaterial, sourceRevision, leaseId, jobSignal) {
      const context = await deseretServiceProjectContext(projectId, "files.upload");
      const bucket = productionStagingBucket();
      const head = await bucket.head(material.objectKey);
      if (!head || head.size !== material.size || !head.etag)
        throw new PublicError("The copied source object is unavailable.", 409, "TRANSFER_SOURCE_CHANGED");
      const checksum = material.sha256 || (material.integrity!.algorithm === "sha256" ? material.integrity!.value : `${material.integrity!.algorithm}:${material.integrity!.value}`);
      const currentSource = {
        sql: "EXISTS(SELECT 1 FROM deseret_project_links link JOIN deseret_material_tasks task ON task.project_id=link.id WHERE link.id=? AND link.source_revision=? AND json_extract(link.state_json,'$.intake')<>'needsSupplement' AND task.id=? AND task.lease_id=? AND task.state='running')",
        values: [projectId, sourceRevision, jobId, leaseId],
      };
      const tasks = (await db.prepare("SELECT id FROM language_projects WHERE project_id=? ORDER BY id").bind(projectId).all<{ id: string }>()).results;
      for (const task of tasks) {
        if (jobSignal.aborted || shuttingDown()) throw new DOMException("Integration is stopping.", "AbortError");
        const receipt = `material:${stableId(`${jobId}:${task.id}`)}`;
        if (await db.prepare("SELECT id FROM deseret_inbox WHERE id=? AND sender='native-material'").bind(receipt).first()) continue;
        const matching = await db.prepare("SELECT version.id,storage.object_key,storage.etag FROM aigc_file_versions version JOIN aigc_files logical ON logical.id=version.file_id JOIN aigc_storage_objects storage ON storage.id=version.storage_object_id WHERE logical.language_project_id=? AND logical.deleted_at IS NULL AND version.original_name=? AND version.checksum_sha256=? AND version.size_bytes=? ORDER BY version.created_at DESC LIMIT 1")
          .bind(task.id, material.name, checksum, material.size).first<{ id: string; object_key: string; etag: string }>();
        if (matching) {
          const existing = await bucket.head(matching.object_key);
          if (!existing || existing.size !== material.size || existing.etag.replaceAll('"', "") !== matching.etag.replaceAll('"', "")) throw new PublicError("The existing native material requires storage reconciliation.", 409, "TRANSFER_SOURCE_CHANGED");
          const at = new Date().toISOString();
          await guardedMutation(db, `${context.access.sql} AND ${currentSource.sql}`, [...context.access.values, ...currentSource.values], [db.prepare("INSERT INTO deseret_inbox(id,sender,project_id,payload_hash,state,response_json,created_at,updated_at) VALUES(?,'native-material',?,?,'complete',?,?,?)").bind(receipt, projectId, createHash("sha256").update(JSON.stringify(material)).digest("hex"), JSON.stringify({ id: matching.id, reused: true }), at, at)]);
          continue;
        }
        const file = storedUploadFile({ name: material.name, type: material.mimeType, size: material.size }, {
          key: material.objectKey, etag: head.etag, sha256: checksum,
          async promote(key, type) {
            if (jobSignal.aborted || shuttingDown()) throw new DOMException("Integration is stopping.", "AbortError");
            const job = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=?").bind(jobId, leaseId).first<{ target_json: string }>();
            const target = job?.target_json ? JSON.parse(job.target_json) : { ...material };
            const attempts: Record<string, unknown>[] = Array.isArray(target.nativeAttempts) ? target.nativeAttempts : [];
            const profile = readMaterialTransferConfig().aigc;
            const owner = stableId(`${jobId}:${task.id}:${key}`);
            if (!attempts.some(attempt => attempt.objectKey === key)) attempts.push({ objectKey: key, storageProfileId: profile.id, bucket: profile.bucket, endpoint: profile.endpoint, region: profile.region, prefix: profile.prefix, owner });
            await guardedMutation(db, `${context.access.sql} AND ${currentSource.sql}`, [...context.access.values, ...currentSource.values], [db.prepare("UPDATE deseret_material_tasks SET target_json=? WHERE id=? AND lease_id=?").bind(JSON.stringify({ ...target, nativeAttempts: attempts }), jobId, leaseId)]);
            const existing = await bucket.head(key);
            if (existing) {
              if (existing.size !== material.size || existing.uploadOwner !== owner) throw new PublicError("The native copy target belongs to a different receipt.", 409, "TRANSFER_DESTINATION_CONFLICT");
              return { etag: existing.etag };
            }
            try {
              return await bucket.copy(material.objectKey, key, head.etag, type, owner, true, {
              signal: jobSignal,
              handle: typeof attempts.find(attempt => attempt.objectKey === key)?.uploadId === "string" ? String(attempts.find(attempt => attempt.objectKey === key)!.uploadId) : undefined,
              async created(handle) {
                const fresh = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=?").bind(jobId, leaseId).first<{ target_json: string }>();
                const latest = fresh ? JSON.parse(fresh.target_json) : null;
                if (!latest || !Array.isArray(latest.nativeAttempts)) throw Error("Native copy inventory is unavailable.");
                const attempt = latest.nativeAttempts.find((item: Record<string, unknown>) => item.objectKey === key);
                if (!attempt) throw Error("Native copy target is unavailable.");
                attempt.uploadId = handle;
                await guardedMutation(db, `${context.access.sql} AND ${currentSource.sql}`, [...context.access.values, ...currentSource.values], [db.prepare("UPDATE deseret_material_tasks SET target_json=? WHERE id=? AND lease_id=?").bind(JSON.stringify(latest), jobId, leaseId)]);
              },
              async assertCurrent() {
                if (jobSignal.aborted) throw new DOMException("Integration is stopping.", "AbortError");
                if (!await db.prepare(`SELECT 1 WHERE ${context.access.sql} AND ${currentSource.sql}`).bind(...context.access.values, ...currentSource.values).first()) throw new PublicError("The material transfer lease changed.", 409, "STALE_RECORD");
              },
              });
            } catch (error) {
              if ((error as Error).name === "NoSuchUpload") {
                const fresh = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=?").bind(jobId, leaseId).first<{ target_json: string }>();
                const latest = fresh ? JSON.parse(fresh.target_json) : null;
                const attempt = latest?.nativeAttempts?.find((item: Record<string, unknown>) => item.objectKey === key);
                if (attempt) {
                  delete attempt.uploadId;
                  await guardedMutation(db, `${context.access.sql} AND ${currentSource.sql}`, [...context.access.values, ...currentSource.values], [db.prepare("UPDATE deseret_material_tasks SET target_json=? WHERE id=? AND lease_id=?").bind(JSON.stringify(latest), jobId, leaseId)]);
                }
              }
              throw error;
            }
          },
        });
        const folder = await db.prepare("SELECT id FROM aigc_folders WHERE language_project_id=? AND folder_code='02' AND deleted_at IS NULL").bind(task.id).first<{ id: string }>();
        if (!folder) throw new PublicError("The native source-material folder is unavailable.", 409, "DESERET_FOLDER_UNAVAILABLE");
        const prepared = await uploadProjectFile(context.actor.email, task.id, "02_客户素材", file, folder.id, undefined, [], { prepareOnly: true });
        if (!("guard" in prepared) || !prepared.guard) throw Error("Native upload preparation did not return a guard.");
        const preparationGuard = prepared.guard;
        await uploadProjectFile(context.actor.email, task.id, "02_客户素材", file, folder.id, undefined, [], {
          identity: kind => stableId(`${jobId}:${task.id}:${kind}`),
          async commit(statements, result) {
            const at = new Date().toISOString();
            await guardedMutation(db, `${context.access.sql} AND (${preparationGuard.sql}) AND ${currentSource.sql} AND NOT EXISTS(SELECT 1 FROM deseret_inbox WHERE id=?)`, [...context.access.values, ...preparationGuard.values, ...currentSource.values, receipt], [
              ...statements,
              db.prepare("UPDATE language_projects SET updated_at=?,revision=revision+1 WHERE id=?").bind(at, task.id),
              db.prepare("INSERT INTO deseret_inbox(id,sender,project_id,payload_hash,state,response_json,created_at,updated_at) VALUES(?,'native-material',?,?,'complete',?,?,?)").bind(receipt, projectId, createHash("sha256").update(JSON.stringify(material)).digest("hex"), JSON.stringify(result), at, at),
            ]);
          },
        });
      }
    },
    async withProject(projectId, work) {
      const context = await deseretServiceProjectContext(projectId, "projects.manage");
      return withBusinessOperation(db, await businessScopes(db, { projectId }), context.actor.email, work);
    },
    async deliver(body, eventId, signal) {
      const endpoint = resolveIntegrationEndpoint(config, "/api/integrations/aigc/events");
      const headers = signIntegrationRequest({ sender: "aigc", keyId: config.outgoingKeyId, secret: config.outgoingSecret, method: "POST", pathAndQuery: endpoint.pathname + endpoint.search, body, requestId: eventId });
      const response = await fetch(endpoint, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body, redirect: "error", signal });
      if (!response.ok) throw Object.assign(Error("Integration delivery failed."), { code: `REMOTE_${response.status}` });
      const acknowledgement: unknown = await response.json();
      if (!acknowledgement || typeof acknowledgement !== "object" || !("accepted" in acknowledgement) || acknowledgement.accepted !== true || !("eventId" in acknowledgement) || acknowledgement.eventId !== eventId)
        throw Object.assign(Error("Integration acknowledgement mismatch."), { code: "REMOTE_ACK_MISMATCH" });
    },
  });
  const scheduler = startDeseretIntegrationScheduler(jobs, {
    track: waitUntil,
    stopping: shuttingDown,
    report(error) {
      const failures = error instanceof AggregateError ? error.errors : [error];
      console.error({ event: "deseret.integration_maintenance_failed", at: new Date().toISOString(), failures: failures.map(item => ({
        stage: ["materials", "reconcile", "outbox"].includes(item?.stage) ? item.stage : "maintenance",
        projectId: typeof item?.projectId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(item.projectId) ? item.projectId : undefined,
        code: ["ACCESS_DENIED", "FORBIDDEN", "STALE_RECORD", "DESERET_OWNER_UNAVAILABLE", "BUSINESS_OPERATION_BLOCKED", "OPERATION_ABORTED"].includes(item?.code) ? item.code : "OPERATION_FAILED",
      })) });
    },
  });
  return scheduler.stop;
}
