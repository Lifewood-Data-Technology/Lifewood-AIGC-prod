import { prepareAuditStatement } from "./audit-write";
import { previousProductionRender, lastProductionFinal } from "./deseret-render-history";
import { deseretSceneSubmission } from "./deseret-scene-submission";
import { submissionNoteRequired } from "../lib/deseret-editor-stage";
import { archiveStatements, engineeringFolderGuard, nativeArchiveFiles, savedArchiveVersionsGuard } from "./deseret-production-archive";
import { deseretArchiveClosedStatuses } from "./backend";
import type { DeseretIntegrationState } from "../lib/deseret-workspace";
import { uploadTypeError, categoryUploadPurpose, uploadSizeError } from "../lib/upload-policy";
import {projectStorageKey} from "../lib/project-storage-key";
import {storageLocation} from "../lib/storage-location";
import type { Database, DatabaseStatement } from "./database";
import { readableStorageFolders, productionWorkspaceContext, detectedUploadFile, streamStoredObject, ensureProductionWorkspaceFolders, projectSummaryUpdateStatement, workflowSubmissionDatabase } from "./backend";
import { guardedMutation } from "./mutation-guard";
import { liveLogicalFileSql, liveFolderSql } from "./file-integrity";
import { PublicError } from "../lib/security-controls";
import { hashFile } from "../lib/file-hash";
import type { UploadExecution } from "./upload-execution";
import { verifiedUpload } from "../runtime/verified-upload";
import { canonicalSubmission, submissionDigest } from "../lib/submission-policy";
import { productionFileCategories, validProductionCategory, parseProductionFileIds, canSubmitProductionVideo } from "../lib/production-files";
import { productionReadableVersionIds, productionReadableVersionQuery } from "./production-file-access";
import { waitUntil } from "../runtime/node-environment";
import { groupDailyReports, reportDay, reportStages, validReportDate } from "../lib/daily-reports";
import { flowState, type FlowEvent } from "../lib/production-flow";

type Row = Record<string, unknown>;
type Context = Awaited<ReturnType<typeof productionWorkspaceContext>>;
const retentionMs = 7 * 86400000;
const activeStates = "('待制作','制作中','质检驳回','客户要求修改')";
function taskGuard(ctx: Context, revision = true, pendingFinal = false, archive = false) {
  const states = pendingFinal ? "('待制作','制作中','质检驳回','客户要求修改','待质检')" : activeStates;
  if (!ctx.authority) throw new PublicError("Write access is required.", 403);
  return { sql: `${ctx.authority.sql} AND EXISTS (SELECT 1 FROM language_projects lp JOIN projects p ON p.id=lp.project_id JOIN clients c ON c.id=p.client_id WHERE lp.id=? AND lp.editor_email=? ${revision ? "AND lp.revision=?" : ""} AND ${archive ? `lp.status NOT IN (${deseretArchiveClosedStatuses.map(status => `'${status}'`).join(",")})` : `lp.status IN ${states}`} AND p.status NOT IN ('已终止','已归档','terminated','archived') AND c.deleted_at IS NULL AND c.status<>'Disabled')`,
    values: [...ctx.authority.values, String(ctx.task.id), ctx.actor.email, ...(revision ? [Number(ctx.task.revision)] : [])] };
}

/** Fixed identifiers only. JSON rows keep statement parameter counts bounded. */
function insertRows(db: Database, table: string, columns: string[], rows: (string | number | null)[][], updateFile = false) {
  return db.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map((_, i) => `json_extract(value,'$[${i}]')`).join(",")} FROM json_each(?) WHERE 1 ${updateFile ? "ON CONFLICT(id) DO UPDATE SET current_version_id=excluded.current_version_id,status=excluded.status,display_name=excluded.display_name,updated_at=excluded.updated_at" : ""}`).bind(JSON.stringify(rows));
}

export async function stageProductionFile(email: string, taskId: string, id: string, purpose: string, category: string, file: File, execution?: UploadExecution) {
  const ctx = await productionWorkspaceContext(email, taskId, true, purpose === "final", purpose === "archive");
  if (!/^[a-f0-9-]{36}$/.test(id) || !["checkpoint", "daily", "final", "materials", "archive"].includes(purpose) || !(validProductionCategory(category) || category === "final")) throw new PublicError("Invalid upload selection.");
  const sizeError = uploadSizeError(file, Boolean(execution?.prepareOnly || verifiedUpload(file)));
  if (sizeError) throw new PublicError(sizeError, 413, "UPLOAD_FILE_SIZE");
  const detected = detectedUploadFile(file);
  if (category === "final" && (purpose !== "final" || detected.kind !== "video")) throw new PublicError("Choose a video for the final.");
  const typeError = uploadTypeError(file, categoryUploadPurpose(category));
  if (typeError) throw new PublicError(typeError);
  if (execution?.prepareOnly) {
    const identity=await ctx.db.prepare('SELECT actor_email,language_project_id,purpose FROM production_staged_files WHERE id=?').bind(id).first<Row>();
    if(identity&&(identity.actor_email!==email||identity.language_project_id!==taskId||identity.purpose!==purpose))throw new PublicError('Upload identity mismatch.',409);
    return {prepared:true,guard:taskGuard(ctx,false,purpose === "final",purpose === "archive")};
  }
  const checksum = await hashFile(file);
  const existing = await ctx.db.prepare("SELECT * FROM production_staged_files WHERE id=?").bind(id).first<Row>();
  if (existing) {
    if (existing.actor_email !== email || existing.language_project_id !== taskId || existing.checksum_sha256 !== checksum || existing.purpose !== purpose) throw new PublicError("Upload identity mismatch.", 409);
    if (existing.state === "ready" && String(existing.expires_at) > new Date().toISOString()) return { ok: true, file: stagedDto(existing) };
    if(execution?.commit&&verifiedUpload(file)&&existing.state==='uploading'&&String(existing.expires_at)>new Date().toISOString()){
      const head=await ctx.bucket.head(String(existing.object_key));
      if(head&&head.uploadOwner!==id){
        await ctx.db.prepare("UPDATE production_staged_files SET object_key='',state='abandoned' WHERE id=? AND state='uploading'").bind(id).run();
        throw new PublicError('The upload name is already in use. Upload again.',409,'UPLOAD_NAME_IN_USE');
      }
      if(!head)await ctx.bucket.put(String(existing.object_key),file,{httpMetadata:{contentType:detected.mimeType}});
      if(!head||head.size===file.size){
        const guard=taskGuard(ctx,false,purpose === "final",purpose === "archive"),result={ok:true,file:stagedDto(existing)},now=new Date().toISOString();
        await execution.commit([ctx.db.prepare("UPDATE production_staged_files SET state='ready',updated_at=? WHERE id=? AND state='uploading'").bind(now,id)],result,{sql:`${guard.sql} AND EXISTS(SELECT 1 FROM production_staged_files WHERE id=? AND actor_email=? AND state='uploading' AND expires_at>?)`,values:[...guard.values,id,email,now]});
        return result;
      }
    }
    throw new PublicError("Upload result is not ready. Refresh to check before retrying.", 409, "UPLOAD_UNCONFIRMED");
  }
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + retentionMs).toISOString();
  const purposeName = {checkpoint: "阶段附件", daily: "工作日报附件", final: "成片", materials: "任务素材"}[purpose] || "制作附件";
  const categoryName = productionFileCategories.find(item => item.id === category)?.zh || "成片";
  const stageFolders = [...await readableStorageFolders(`folder-language-${taskId}`), "制作工作区", purposeName, categoryName];
  const keyForVersion = (version: number) => projectStorageKey({environment: process.env.LIFEWOOD_ENV, legacyKey: `production-staging/${id}`,
    folderNames: stageFolders,
    fileId: id, objectId: id, version, originalName: file.name, extension: detected.extension});
  const guard = taskGuard(ctx, false, purpose === "final", purpose === "archive");
  let key = "";
  // Reserve readable names in the serialized database batch before storage I/O.
  // Expired records retain their reservation so a delayed cleaner cannot delete
  // a later upload that reused the name.
  for (let version = 1; version <= 100; version++) {
    key = keyForVersion(version);
    if (["test","audit"].includes(process.env.LIFEWOOD_ENV||"") && (await ctx.bucket.head(key))) continue;
    try {
  // Bound unfinished storage per account without counting already committed files.
      await guardedMutation(ctx.db, `${guard.sql} ${["test","audit"].includes(process.env.LIFEWOOD_ENV||"") ? "AND NOT EXISTS (SELECT 1 FROM production_staged_files WHERE object_key=?)" : ""} AND (SELECT COUNT(*) FROM production_staged_files WHERE actor_email=? AND state IN ('uploading','ready')) < 200 AND (SELECT COALESCE(SUM(size_bytes),0) FROM production_staged_files WHERE actor_email=? AND state IN ('uploading','ready')) + ? <= 2147483648`,
    [...guard.values, ...(["test","audit"].includes(process.env.LIFEWOOD_ENV||"") ? [key] : []), email, email, file.size], [ctx.db.prepare("INSERT INTO production_staged_files (id,actor_email,language_project_id,purpose,category,original_name,mime_type,file_kind,size_bytes,checksum_sha256,object_key,state,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'uploading',?,?,?)")
      .bind(id,email,taskId,purpose,category,file.name,detected.mimeType,detected.kind,file.size,checksum,key,now,now,expires)]);
      break;
    } catch (error) {
      if (!["test","audit"].includes(process.env.LIFEWOOD_ENV||"") || !(error instanceof PublicError) || error.code !== "STALE_RECORD" ||
        !(await ctx.db.prepare("SELECT id FROM production_staged_files WHERE object_key=?").bind(key).first())) throw error;
      key = "";
    }
  }
  const reserved = await ctx.db.prepare("SELECT object_key FROM production_staged_files WHERE id=? AND state='uploading'").bind(id).first<Row>();
  if (!reserved || reserved.object_key !== key) throw new PublicError("Too many same-name uploads. Choose another file name.", 409);
  const storageStarted = Date.now();
  try {
    console.info({event:"upload.storage.start", fileId:id});
    await ctx.bucket.put(key, file, { httpMetadata: { contentType: detected.mimeType } });
    console.info({event:"upload.storage.complete", fileId:id, durationMs:Date.now()-storageStarted});
    const condition = `${guard.sql} AND EXISTS(SELECT 1 FROM production_staged_files WHERE id=? AND state IN ('uploading','ready'))`;
    const statements = [ctx.db.prepare("UPDATE production_staged_files SET state='ready',updated_at=? WHERE id=?").bind(new Date().toISOString(),id)];
    const result = {ok:true,file:stagedDto({id,original_name:file.name,mime_type:detected.mimeType,file_kind:detected.kind,size_bytes:file.size,category,purpose,expires_at:expires,created_at:now})};
    if (execution?.commit) await execution.commit(statements,result,{sql:condition,values:[...guard.values,id]});
    else await guardedMutation(ctx.db, condition, [...guard.values,id], statements);
  } catch (error) {
    // A conditional-write rejection proves this key belongs to another object.
    // Never leave that key in a cleanup-eligible record.
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412) {
      await ctx.db.prepare("UPDATE production_staged_files SET object_key='',state='abandoned' WHERE id=? AND state='uploading'").bind(id).run();
      throw new PublicError("The upload name is already in use. Upload again.", 409);
    }
    // A timeout/connection loss cannot prove that Wasabi rejected the write.
    // Keep the original identity eligible for HEAD reconciliation, never replay
    // PUT automatically. Existing seven-day expiry still owns eventual cleanup.
    const name = error instanceof Error ? error.name : "Unknown";
    console.warn({event:"upload.storage.unconfirmed", fileId:id, durationMs:Date.now()-storageStarted, reason:["TimeoutError","AbortError"].includes(name)?name:"STORAGE_OR_COMMIT_ERROR"});
    throw error;
  }
  const row = await ctx.db.prepare("SELECT * FROM production_staged_files WHERE id=?").bind(id).first<Row>();
  return { ok: true, file: stagedDto(row!) };
}

function stagedDto(row: Row) {
  return { id: row.id, name: row.original_name, mimeType: row.mime_type, kind: row.file_kind, size: row.size_bytes, category: row.category, purpose: row.purpose, expiresAt: row.expires_at, createdAt: row.created_at, thumbnailRevision:row.thumbnail_revision??null, staged: true };
}

/** Reconcile only the caller's exact upload. A missing HEAD is not a failure. */
export async function productionUploadStatus(email: string, taskId: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new PublicError("Invalid upload selection.");
  // Authorise by the staged upload's own purpose: a Deseret archive upload stays open through QC and review.
  const owned = await (await productionWorkspaceContext(email, taskId)).db.prepare("SELECT purpose FROM production_staged_files WHERE id=? AND actor_email=? AND language_project_id=?").bind(id,email,taskId).first<Row>();
  const archiveUpload = owned?.purpose === "archive";
  const ctx = await productionWorkspaceContext(email, taskId, true, true, archiveUpload);
  const row = await ctx.db.prepare("SELECT * FROM production_staged_files WHERE id=? AND actor_email=? AND language_project_id=? AND expires_at>? AND purpose=?")
    .bind(id,email,taskId,new Date().toISOString(),String(owned?.purpose ?? "")).first<Row>();
  if (!row) return {state:"unconfirmed"};
  if (ctx.task.status === "待质检" && row.purpose !== "final" && !archiveUpload) throw new PublicError("Only final uploads can change while awaiting review.",403);
  // A direct upload becomes ready only with its verified atomic receipt. The
  // legacy size-only HEAD recovery must never promote a direct reservation.
  const direct=await ctx.db.prepare('SELECT state FROM direct_upload_sessions WHERE id=? AND actor_email=?').bind(id,email).first<{state:string}>();
  if(direct&&direct.state!=='ready')return {state:'unconfirmed'};
  if (row.state === "ready") return {state:"ready",file:stagedDto(row)};
  if (row.state !== "uploading" || !row.object_key) return {state:"unconfirmed"};
  const head = await ctx.bucket.head(String(row.object_key));
  if (!head || head.size !== Number(row.size_bytes)) return {state:"unconfirmed"};
  const guard = taskGuard(ctx, false, row.purpose === "final", archiveUpload), now = new Date().toISOString();
  await guardedMutation(ctx.db, `${guard.sql} AND EXISTS(SELECT 1 FROM production_staged_files WHERE id=? AND actor_email=? AND language_project_id=? AND state IN ('uploading','ready') AND expires_at>?)`,
    [...guard.values,id,email,taskId,now], [ctx.db.prepare("UPDATE production_staged_files SET state='ready',updated_at=? WHERE id=? AND state='uploading'").bind(now,id)]);
  console.info({event:"upload.storage.reconciled",fileId:id});
  return {state:"ready",file:stagedDto(row)};
}

export async function streamStagedProductionFile(email: string, id: string, download: boolean, range: string | null, thumbnail = false) {
  const row = await workflowSubmissionDatabase().prepare("SELECT * FROM production_staged_files WHERE id=? AND actor_email=? AND state='ready' AND expires_at>?").bind(id,email,new Date().toISOString()).first<Row>();
  if (!row) throw new PublicError("Temporary file is unavailable.", 404);
  await productionWorkspaceContext(email,String(row.language_project_id));
  if(thumbnail){
    const preview=await workflowSubmissionDatabase().prepare('SELECT object_key FROM aigc_file_previews WHERE file_version_id=?').bind(id).first<{object_key:string}>();
    if(!preview)throw new PublicError('The video preview has not been generated yet.',404,'PREVIEW_NOT_GENERATED');
    return streamStoredObject(preview.object_key,'preview.jpg',false,null,'image/jpeg');
  }
  return streamStoredObject(String(row.object_key),String(row.original_name),download,range,String(row.mime_type));
}

/** Claim first, delete second. A successful submission cannot lose its objects. */
export async function cleanupProductionStaging(email?: string) {
  const db = workflowSubmissionDatabase();
  const candidates = (await db.prepare("SELECT id FROM production_staged_files WHERE (? IS NULL OR actor_email=?) AND (state IN ('abandoned','cleanup_claimed') OR (state IN ('ready','uploading') AND expires_at<=?)) ORDER BY expires_at LIMIT 30").bind(email??null,email??null,new Date().toISOString()).all<{id:string}>()).results;
  for (const item of candidates) {
    const row = await db.prepare("UPDATE production_staged_files SET state='cleanup_claimed' WHERE id=? AND (state IN ('abandoned','cleanup_claimed') OR (state IN ('ready','uploading') AND expires_at<=?)) RETURNING *").bind(item.id,new Date().toISOString()).first<Row>();
    if (!row) continue;
    // Bucket is not exposed to a client; account/task changes do not prevent expiry cleanup.
    const { productionStagingBucket } = await import("./backend");
    if (row.object_key) await productionStagingBucket().delete(String(row.object_key));
    // Keep the row until deletion succeeds, so a failed sweep can resume.
    const preview=await db.prepare('SELECT object_key FROM aigc_file_previews WHERE file_version_id=?').bind(item.id).first<{object_key:string}>();
    if(preview?.object_key){
      await productionStagingBucket().delete(preview.object_key);
      await db.prepare('DELETE FROM aigc_file_previews WHERE file_version_id=? AND object_key=?').bind(item.id,preview.object_key).run();
    }
    // Keep an identity tombstone: a delayed cleaner must never delete a reused key.
    await db.prepare("UPDATE production_staged_files SET state='expired',original_name='',checksum_sha256='',object_key=CASE WHEN ?=1 THEN object_key ELSE '' END,updated_at=? WHERE id=? AND state='cleanup_claimed'").bind(['test','audit'].includes(process.env.LIFEWOOD_ENV||'') ? 1 : 0,new Date().toISOString(),item.id).run();
  }
}

export async function discardStagedProductionFile(email: string, taskId: string, id: string) {
  const ctx = await productionWorkspaceContext(email,taskId);
  // Task access is rechecked in the same write; a reassignment or disablement after the check refuses it.
  const [, discarded] = await guardedMutation(ctx.db, ctx.access.sql, ctx.access.values, [ctx.db.prepare("UPDATE production_staged_files SET state='abandoned',updated_at=? WHERE id=? AND actor_email=? AND language_project_id=? AND state='ready'").bind(new Date().toISOString(),id,email,taskId)]);
  // Never report a discard that did not happen (already committed, expired or not this uploader's).
  if (!discarded?.meta?.changes) throw new PublicError("This temporary file is no longer available to discard. Refresh to check its state.", 409, "STAGED_FILE_UNAVAILABLE");
  await cleanupProductionStaging(email);
  return { ok: true };
}

export async function productionWorkspaceData(email: string, taskId: string) {
  const ctx = await productionWorkspaceContext(email,taskId);
  // Bounded global sweep also reaches expired uploads of inactive accounts.
  // Expiry is enforced immediately on reads; physical cleanup is activity-driven.
  waitUntil(cleanupProductionStaging().catch(()=>console.warn("production.staging.cleanup_deferred")));
  const files = (await ctx.db.prepare(`SELECT v.id,v.file_id,v.original_name AS name,v.mime_type AS mimeType,v.size_bytes AS size,v.version_number AS version,v.created_at AS createdAt,pf.status AS status,v.created_by AS uploadedBy,a.name AS uploaderName,f.file_kind AS kind,COALESCE(folder.folder_code,(WITH RECURSIVE ancestors(id,parent_folder_id,folder_code,depth) AS (SELECT id,parent_folder_id,folder_code,0 FROM aigc_folders WHERE id=f.folder_id UNION ALL SELECT parent.id,parent.parent_folder_id,parent.folder_code,ancestors.depth+1 FROM aigc_folders parent JOIN ancestors ON parent.id=ancestors.parent_folder_id WHERE ancestors.depth<40) SELECT folder_code FROM ancestors WHERE folder_code='02' OR folder_code LIKE '02.%' ORDER BY depth LIMIT 1)) AS category,f.current_version_id AS currentVersionId,preview.updated_at AS thumbnailRevision FROM aigc_file_versions v JOIN aigc_files f ON f.id=v.file_id JOIN project_files pf ON pf.id=v.id JOIN aigc_folders folder ON folder.id=f.folder_id LEFT JOIN accounts a ON a.email=v.created_by LEFT JOIN aigc_file_previews preview ON preview.file_version_id=v.id WHERE f.language_project_id=? AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")} ORDER BY v.created_at DESC`).bind(taskId).all<Row>()).results;
  const libraryFiles=(await ctx.db.prepare(`SELECT v.id,v.original_name AS name,v.mime_type AS mimeType,v.size_bytes AS size,v.version_number AS version,v.created_at AS createdAt,v.created_by AS uploadedBy,a.name AS uploaderName,f.file_kind AS kind,f.current_version_id AS currentVersionId,1 AS library,preview.updated_at AS thumbnailRevision FROM aigc_file_versions v JOIN aigc_files f ON f.id=v.file_id JOIN project_files pf ON pf.id=v.id JOIN aigc_folders folder ON folder.id=f.folder_id LEFT JOIN accounts a ON a.email=v.created_by LEFT JOIN aigc_file_previews preview ON preview.file_version_id=v.id WHERE f.source='internal' AND (folder.node_type LIKE 'library%' OR folder.path_cache LIKE '/Asset Library%') AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")} ORDER BY v.created_at DESC`).all<Row>()).results;
  const handovers = (await ctx.db.prepare("SELECT h.*,a.name AS fromName FROM handover_records h LEFT JOIN accounts a ON a.email=h.from_user_email WHERE h.language_project_id=? AND h.status IN ('pending','accepted') ORDER BY h.created_at DESC").bind(taskId).all<Row>()).results;
  const members = (await ctx.db.prepare("SELECT m.* FROM production_checkpoint_files m JOIN handover_records h ON h.checkpoint_id=m.checkpoint_id WHERE h.language_project_id=? AND h.status IN ('pending','accepted')").bind(taskId).all<Row>()).results;
  let finals = (await ctx.db.prepare("SELECT s.*,a.name AS uploader_name FROM production_final_submissions s LEFT JOIN accounts a ON a.email=s.submitted_by WHERE s.language_project_id=? ORDER BY s.submitted_at DESC").bind(taskId).all<Row>()).results;
  const finalFiles = (await ctx.db.prepare("SELECT m.* FROM production_final_submission_files m JOIN production_final_submissions s ON s.id=m.submission_id WHERE s.language_project_id=?").bind(taskId).all<Row>()).results;
  const authorizedVersions = ctx.actor.access === "production" ? await productionReadableVersionIds(ctx.db,email) : null;
  const visible = files.filter(f=> !authorizedVersions || authorizedVersions.has(String(f.id)));
  const knownFinals=new Set(finals.map(f=>String(f.final_version_id)));
  finals=[...finals,...visible.filter(f=>f.category==="03.render.video"&&!knownFinals.has(String(f.id))).map(f=>({id:`legacy-${f.id}`,language_project_id:taskId,final_version_id:f.id,submitted_by:f.uploadedBy,submitted_at:f.createdAt,uploader_name:f.uploaderName,legacy:true}))].sort((a,b)=>String(b.submitted_at).localeCompare(String(a.submitted_at)));
  const documents = (await ctx.db.prepare("SELECT d.id,d.original_name AS name,d.mime_type AS mimeType,d.size_bytes AS size,d.created_at AS createdAt,a.name AS uploaderName FROM project_request_documents d JOIN project_requests r ON r.id=d.request_id LEFT JOIN accounts a ON a.email=d.uploaded_by WHERE r.project_id=? AND r.status='accepted' AND d.request_revision=r.revision AND d.deleted_at IS NULL").bind(ctx.task.project_id).all<Row>()).results;
  const staged = ctx.actor.access === "production" ? (await ctx.db.prepare("SELECT s.*, (SELECT updated_at FROM aigc_file_previews WHERE file_version_id=s.id) AS thumbnail_revision FROM production_staged_files s WHERE actor_email=? AND language_project_id=? AND state='ready' AND expires_at>? ORDER BY created_at DESC").bind(email,taskId,new Date().toISOString()).all<Row>()).results.map(stagedDto) : [];
  const checkpoints=(await ctx.db.prepare("SELECT cp.*,a.name AS editor_name FROM production_checkpoints cp LEFT JOIN accounts a ON a.email=cp.editor_email WHERE cp.language_project_id=? ORDER BY cp.version_number DESC").bind(taskId).all<Row>()).results;
  const checkpointFiles=(await ctx.db.prepare("SELECT m.* FROM production_checkpoint_files m JOIN production_checkpoints cp ON cp.id=m.checkpoint_id WHERE cp.language_project_id=?").bind(taskId).all<Row>()).results;
  const visibleMembers=(rows:Row[])=>authorizedVersions?rows.filter(m=>authorizedVersions.has(String(m.file_version_id))):rows;
  const flowEvents=(await ctx.db.prepare("SELECT e.*,a.name AS actor_name FROM production_flow_events e LEFT JOIN accounts a ON a.email=e.actor_email WHERE e.language_project_id=? ORDER BY e.task_revision DESC").bind(taskId).all<FlowEvent>()).results;
  const flowFiles=(await ctx.db.prepare("SELECT m.* FROM production_flow_files m JOIN production_flow_events e ON e.id=m.event_id WHERE e.language_project_id=?").bind(taskId).all<Row>()).results;
  const pendingFinalVersionId = ctx.task.status === "待质检" ? await ctx.db.prepare(`SELECT f.current_version_id FROM aigc_files f JOIN aigc_folders folder ON folder.id=f.folder_id JOIN project_files pf ON pf.id=f.current_version_id WHERE f.language_project_id=? AND folder.folder_code='03.render.video' AND f.status='pending_qc' AND pf.status='pending_qc' AND ${liveLogicalFileSql("f")}`).bind(taskId).first<string>("current_version_id") : null;
  const link = await ctx.db.prepare("SELECT state_json,revision FROM deseret_project_links WHERE id=?").bind(ctx.task.project_id).first<{ state_json: string; revision: number }>();
  const state = link ? JSON.parse(link.state_json) as DeseretIntegrationState : null;
  const publishedFinalVersionIds = state?.packages.filter(pack => pack.phase === "final")
    .flatMap(pack => pack.files.filter(file => file.languageTaskId === taskId).map(file => file.fileVersionId)) ?? [];
  const deseret = state && link ? { revision: Number(link.revision), publishedFinalVersionIds, stage: state.stage, intake: state.intake, materials: state.materials, scenes: state.scenes.filter(scene => scene.languageTaskId === taskId) } : undefined;
  return { deseret, pendingFinalVersionId, task: ctx.task, flowEvents, flowFiles:visibleMembers(flowFiles), files: visible, libraryFiles, documents: documents.map(d=>({...d,kind:"document",document:true})), handovers, members:visibleMembers(members), finals, finalFiles:visibleMembers(finalFiles), staged, checkpoints, checkpointFiles:visibleMembers(checkpointFiles) };
}

export async function submitProductionWorkspace(email: string, payload: Record<string,string>) {
  const taskId=payload.languageProjectId, id=payload.submissionId;
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new PublicError("A submission identity is required.");
  const readContext=await productionWorkspaceContext(email,taskId), db=readContext.db;
  const hash=await submissionDigest(canonicalSubmission("production.workspace.submit",payload));
  const previous=await db.prepare("SELECT * FROM production_submission_receipts WHERE id=?").bind(id).first<Row>();
  if(previous){if(previous.actor_email!==email||previous.payload_hash!==hash)throw new PublicError("Submission identity mismatch.",409);return JSON.parse(String(previous.response_json));}
  const ctx=await productionWorkspaceContext(email,taskId,true,payload.kind === "final",payload.kind === "archive"), {task,actor}=ctx;
  const final=payload.kind==="final";
  const daily=payload.kind==="daily";
  // Deseret internal archive: saved like materials, then recorded as an archive in the same transaction.
  const archive=payload.kind==="archive";
  const materials=payload.kind==="materials"||archive;
  const reopening=payload.kind==="flow_reopen",flowStage=payload.flowStage||"";
  let flowEvent:DatabaseStatement|null=null;
  if(archive&&(payload.flowStage||payload.kind!=="archive"))throw new PublicError("Invalid production flow action.");
  if(flowStage||reopening){
    const publisherProject = await db.prepare("SELECT id FROM deseret_project_links WHERE id=?").bind(task.project_id).first();
    if (publisherProject) throw new PublicError("Use the storyboard workflow for this publisher project.", 409, "DESERET_STORYBOARD_WORKFLOW");

    if(!materials&&!reopening)throw new PublicError("Invalid production flow action.");
    if(Number(payload.expectedRevision)!==Number(task.revision))throw new PublicError("Task changed. Refresh before saving.",409);
    const events=(await db.prepare("SELECT * FROM production_flow_events WHERE language_project_id=?").bind(taskId).all<FlowEvent>()).results;
    const states=flowState(events),index=states.findIndex(stage=>stage.id===flowStage),state=states[index];
    if(!state||reopening&&!state.completed||!reopening&&(state.completed||states.slice(0,index).some(stage=>!stage.completed)))throw new PublicError("Complete previous stages first, or reopen a completed stage before updating.",409);
    const now=new Date().toISOString();
    flowEvent=db.prepare("INSERT INTO production_flow_events(id,language_project_id,stage,action,task_revision,actor_email,created_at) VALUES(?,?,?,?,?,?,?)").bind(id,taskId,flowStage,reopening?"reopen":"complete",Number(task.revision)+1,email,now);
    if(reopening){
      const guard=taskGuard(ctx),output={ok:true,submissionId:id};
      try{await guardedMutation(db,guard.sql,guard.values,[flowEvent,
        db.prepare("UPDATE language_projects SET revision=revision+1,updated_at=? WHERE id=?").bind(now,taskId),
        prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('production.flow_reopened',?,?,?,?)").bind(email,taskId,flowStage,now),
        db.prepare("INSERT INTO production_submission_receipts(id,actor_email,payload_hash,response_json,created_at) VALUES(?,?,?,?,?)").bind(id,email,hash,JSON.stringify(output),now)]);
      }catch(error){const receipt=await db.prepare("SELECT response_json FROM production_submission_receipts WHERE id=? AND actor_email=? AND payload_hash=?").bind(id,email,hash).first<{response_json:string}>();if(receipt)return JSON.parse(receipt.response_json);throw error;}
      return output;
    }
  }
  if(!final&&!daily&&!materials&&payload.kind!=="checkpoint")throw new PublicError("Invalid submission kind.");
  const workDate=daily?payload.workDate:reportDay();
  if(daily&&(!validReportDate(workDate)||!reportStages.some(stage=>stage[0]===payload.stage)||String(payload.nextSteps||"").length>1000))throw new PublicError("Choose a valid work date and production stage.");
  const reports=daily?groupDailyReports((await db.prepare("SELECT * FROM production_checkpoints WHERE language_project_id=? ORDER BY version_number").bind(taskId).all<Row>()).results):[];
  const priorReport=reports.find(report=>report.date===workDate);
  if(daily&&String(priorReport?.latest.id||"")!==String(payload.reportRevisionId||""))throw new PublicError("This daily report changed. Reload before supplementing.",409);
  if(final&&!['制作中','质检驳回','客户要求修改','待质检'].includes(String(task.status)))throw new PublicError("This task is not open for a final submission.",409);
  const percent=Number(payload.percent), note=String(payload.note||"").trim();
  const replacing = final && task.status === "待质检";
  const pendingFinal = replacing ? await db.prepare(`SELECT f.id AS file_id,f.current_version_id,pf.version FROM aigc_files f JOIN aigc_folders folder ON folder.id=f.folder_id JOIN project_files pf ON pf.id=f.current_version_id WHERE f.language_project_id=? AND folder.folder_code='03.render.video' AND f.status='pending_qc' AND pf.status='pending_qc' AND ${liveLogicalFileSql("f")}`).bind(taskId).all<Row>() : null;
  const oldFinal = pendingFinal?.results[0];
  if(replacing && (pendingFinal?.results.length !== 1 || !oldFinal || payload.replacesVersionId !== oldFinal.current_version_id))
    throw new PublicError("The pending final changed. Refresh before replacing it.",409,"FINAL_REPLACEMENT_CHANGED");
  if(!replacing && payload.replacesVersionId)throw new PublicError("The pending final changed. Refresh before replacing it.",409,"FINAL_REPLACEMENT_CHANGED");
  if(replacing && !note)throw new PublicError("Enter the reason for replacing the pending final.");

  if(final&&payload.materialsConfirmed!=="true")throw new PublicError("Confirm the materials associated with this final before submitting.");
  const linkedReport=final&&payload.dailyReportRevisionId?await db.prepare("SELECT id,updated_at FROM production_checkpoints WHERE id=? AND language_project_id=? AND status NOT IN ('invalidated','failed')").bind(payload.dailyReportRevisionId,taskId).first<Row>():null;
  if(final&&payload.dailyReportRevisionId&&!linkedReport)throw new PublicError("The daily report revision is unavailable.",409);
  const checkpointMode=materials?"new":daily?(priorReport?"correct":"new"):payload.checkpointMode||"new";
  if(!["new","edit","correct"].includes(checkpointMode))throw new PublicError("Invalid checkpoint mode.");
  const source=daily?priorReport?.latest||null:!final&&checkpointMode!=="new"?await db.prepare("SELECT * FROM production_checkpoints WHERE id=? AND language_project_id=? AND editor_email=?").bind(payload.sourceCheckpointId||"",taskId,email).first<Row>():null;
  if(!final&&checkpointMode!=="new"&&!source)throw new PublicError("The checkpoint to edit is unavailable.",409);
  const directEdit=!final&&checkpointMode==="edit";
  if(!daily&&source&&Number(source.attachment_schema)>=3)throw new PublicError("Use the daily report workflow to preserve revisions.",409);
  if(!daily&&source&&String(source.updated_at)!==payload.sourceUpdatedAt)throw new PublicError("This checkpoint changed. Reload before editing.",409);
  if(directEdit&&(source?.status!=="ready"||String(source.editable_until)<new Date().toISOString()||await db.prepare("SELECT id FROM handover_records WHERE checkpoint_id=? LIMIT 1").bind(source.id).first()))throw new PublicError("This checkpoint is locked. Create a correction instead.",409);
  // A Deseret scene submitted in the storyboard round needs only its video and duration. Whether this final is
  // such a scene is decided below by the scene registration that joins this transaction; a replacement keeps
  // its required reason and every other submission keeps its note.
  if(!materials&&((!note&&!(final&&!replacing))||note.length>1000||!Number.isInteger(percent)||percent<0||(!final&&!daily&&percent>=100)||percent>100))throw new PublicError("Enter work notes and a valid progress percentage.");
  if(Number(payload.expectedRevision)!==Number(task.revision))throw new PublicError("Task changed. Refresh before saving.",409);
  let ids:string[];
  try{ids=parseProductionFileIds(payload.fileIds);}catch{throw new PublicError("Invalid file selection (maximum 50 files).");}
  let categories:Record<string,string>;
  try{categories=JSON.parse(payload.categories||"{}");if(!categories||Array.isArray(categories)||typeof categories!=="object")throw Error();}catch{throw new PublicError("Invalid file categories.");}
  const now=new Date().toISOString();
  const staged=(await db.prepare("SELECT * FROM production_staged_files WHERE id IN (SELECT value FROM json_each(?)) AND actor_email=? AND language_project_id=? AND state='ready' AND expires_at>?").bind(JSON.stringify(ids),email,taskId,now).all<Row>()).results;
  const existingData=await productionWorkspaceData(email,taskId);
  if(final&&!note&&!existingData.deseret)throw new PublicError("Enter work notes and a valid progress percentage.");
  const existing=[...existingData.files,...existingData.libraryFiles].filter(f=>ids.includes(String(f.id)));
  if(materials&&!archive&&(!ids.length||!flowStage&&staged.length!==ids.length))throw new PublicError("Select temporary files to save as materials.");
  if(archive&&(!ids.length||existing.some(file=>file.library)))throw new PublicError("Choose this task's engineering file to archive.",422,"DESERET_ARCHIVE_INVALID");
  if(archive&&String(payload.nextSteps||"").length>4000)throw new PublicError("Next steps are limited to 4000 characters.",422,"DESERET_ARCHIVE_INVALID");
  if(flowStage&&existing.some(file=>file.library||file.currentVersionId!==file.id||!productionFileCategories.some(category=>category.code===file.category)))throw new PublicError("Choose current task production files for this stage.");
  if(new Set([...staged.map(f=>String(f.id)),...existing.map(f=>String(f.id))]).size!==ids.length)throw new PublicError("One or more files are unavailable. Review your selection.",409);
  const selectedFinalId=String(payload.finalVersionId||"");
  let finalId=selectedFinalId;
  if(final && (!ids.includes(finalId)||![...staged,...existing].some(f=>f.id===finalId&&(f.file_kind||f.kind)==="video")))throw new PublicError("Choose the final video.");
  const existingFinal=existing.find(f=>f.id===finalId);
  if(final && existingFinal && !canSubmitProductionVideo(existingFinal)) throw new PublicError("Choose a current production video or final video.");
  const promoteSource=final && existingFinal && existingFinal.category!=="03.render.video" ? existingFinal : null;
  if(final && (!task.reviewer_email||await db.prepare("SELECT id FROM handover_records WHERE language_project_id=? AND status='pending'").bind(taskId).first()))throw new PublicError("Confirm handover and an assigned reviewer before submitting.");
  if(final && !await db.prepare("SELECT email FROM accounts WHERE email=? AND access_group='quality' AND status='active'").bind(task.reviewer_email).first())throw new PublicError("The assigned reviewer is unavailable.");
  await ensureProductionWorkspaceFolders(db,taskId,email);
  const folders=(await db.prepare("SELECT * FROM aigc_folders WHERE language_project_id=? AND deleted_at IS NULL").bind(taskId).all<Row>()).results;
  const statements:DatabaseStatement[]=[];
  if(flowEvent)statements.push(flowEvent,insertRows(db,"production_flow_files",["id","event_id","file_version_id"],ids.map(fileId=>[crypto.randomUUID(),id,fileId])));
  const rows:{pf:(string|number|null)[][]; storage:(string|number|null)[][];versions:(string|number|null)[][];files:(string|number|null)[][]}={pf:[],storage:[],versions:[],files:[]};
  const selectedCategories=new Map<string,string>();
  const destinations:string[]=[];
  const priorStageVersions=flowStage?(await db.prepare(`SELECT f.id,f.current_version_id,v.original_name,folder.folder_code,(SELECT COALESCE(MAX(version_number),0)+1 FROM aigc_file_versions WHERE file_id=f.id) AS next_version FROM production_flow_files m JOIN production_flow_events e ON e.id=m.event_id JOIN aigc_file_versions v ON v.id=m.file_version_id JOIN aigc_files f ON f.id=v.file_id JOIN aigc_folders folder ON folder.id=f.folder_id WHERE e.id=(SELECT id FROM production_flow_events WHERE language_project_id=? AND stage=? AND action='complete' ORDER BY task_revision DESC LIMIT 1) AND f.current_version_id=v.id AND ${liveLogicalFileSql("f")}`).bind(taskId,flowStage).all<Row>()).results:[];
  const advancedStageFiles:Row[]=[];
  let priorFinal:Row|null=null;
  if (final && (promoteSource || staged.some(file => file.id === finalId))) {
    const publisher = existingData.deseret;
    let sceneId: unknown;
    if (publisher?.stage === "production" && payload.deseretScene) {
      try { sceneId = JSON.parse(payload.deseretScene)?.id; }
      catch { throw new PublicError("Check the scene duration.", 400, "DESERET_SCENE_INVALID"); }
    }
    priorFinal = await previousProductionRender(db, taskId, {
      replacesVersionId: oldFinal ? String(oldFinal.current_version_id) : undefined,
      phase: publisher?.stage === "production" ? "storyboard" : publisher?.stage === "final_production" ? "final" : undefined,
      sceneVersionId: publisher?.scenes.find(scene => scene.id === sceneId)?.fileVersionId,
      publishedFinalVersionIds: publisher?.publishedFinalVersionIds,
    });
  }
  if(replacing && (!priorFinal || priorFinal.id !== oldFinal?.file_id || priorFinal.current_version_id !== oldFinal?.current_version_id))
    throw new PublicError("Choose a new video to replace the pending final.",409,"FINAL_REPLACEMENT_CHANGED");
  // Saved archive versions keep their existing folders. Only newly filed versions need an upload category.
  for(const file of archive ? staged : [...existing,...staged]){
    const fileId=String(file.id), category=final&&fileId===finalId?"final":categories[fileId]||productionFileCategories.find(c=>c.code===file.category)?.id||String(file.category);
    if(category==="final"&&(!final||fileId!==finalId))throw new PublicError("Only one file can be the final video.");
    if(category!=="final"&&!validProductionCategory(category))throw new PublicError("Choose a category for every production file.");
    selectedCategories.set(fileId,category);
  }
  for(const file of staged){
    const category=selectedCategories.get(String(file.id))!;
    if(category!==String(file.category)){
      const typeError=uploadTypeError({name:String(file.original_name),type:String(file.mime_type)},categoryUploadPurpose(category));
      if(typeError)throw new PublicError(typeError);
    }
    const code=category==="final"?"03.render.video":productionFileCategories.find(c=>c.id===category)!.code;
    const folder=folders.find(f=>f.folder_code===code);
    if(!folder)throw new PublicError("The destination folder is unavailable.");
    destinations.push(String(folder.id));
    const object=await ctx.bucket.head(String(file.object_key));
    if(!object||object.size!==file.size_bytes)throw new PublicError("An upload is incomplete. Please upload it again.");
    const matches=priorStageVersions.filter(prior=>prior.original_name===file.original_name&&prior.folder_code===code);
    const priorStage=matches.length===1&&!advancedStageFiles.some(prior=>prior.id===matches[0].id)?matches[0]:null;
    if(priorStage)advancedStageFiles.push(priorStage);
    const versionId=String(file.id), logicalId=category==="final"&&priorFinal?String(priorFinal.id):priorStage?String(priorStage.id):`production-${versionId}`,storageId=`production-${versionId}`;
    const version=category==="final"&&priorFinal?Number(priorFinal.next_version):priorStage?Number(priorStage.next_version):1;
    rows.pf.push([versionId,String(task.project_id),taskId,"03_项目制作",String(file.original_name),String(file.original_name),String(file.object_key),String(file.mime_type),Number(file.size_bytes),version,email,final&&versionId===finalId?"pending_qc":"available","project",now]);
    const location=storageLocation();
    rows.storage.push([storageId,location.provider,location.bucket,location.region,location.endpoint,String(file.object_key),object.etag,"STANDARD",now]);
    rows.versions.push([versionId,logicalId,version,String(file.original_name),String(file.original_name),storageId,String(file.mime_type),Number(file.size_bytes),String(file.checksum_sha256),email,now]);
    rows.files.push([logicalId,taskId,String(folder.id),String(file.original_name),String(file.file_kind),versionId,final&&versionId===finalId?"pending_qc":"available","project",email,now,now]);
  }
  if(promoteSource){
    // A new immutable final version shares the bytes, never the source's status
    // or logical identity. Existing reports and source-folder links stay intact.
    const sourceVersion=await db.prepare("SELECT v.*,s.object_key FROM aigc_file_versions v JOIN aigc_storage_objects s ON s.id=v.storage_object_id WHERE v.id=?").bind(selectedFinalId).first<Row>();
    const folder=folders.find(f=>f.folder_code==="03.render.video");
    if(!sourceVersion||!folder)throw new PublicError("The source video or destination folder is unavailable.",409);
    const object=await ctx.bucket.head(String(sourceVersion.object_key));
    if(!object||object.size!==Number(sourceVersion.size_bytes))throw new PublicError("The source video is unavailable.",409);
    finalId=crypto.randomUUID();
    const logicalId=priorFinal?String(priorFinal.id):`production-${finalId}`,version=priorFinal?Number(priorFinal.next_version):1;
    destinations.push(String(folder.id));
    rows.pf.push([finalId,String(task.project_id),taskId,"03_项目制作",String(sourceVersion.original_name),String(sourceVersion.original_name),String(sourceVersion.object_key),String(sourceVersion.mime_type),Number(sourceVersion.size_bytes),version,email,"pending_qc","project",now]);
    rows.versions.push([finalId,logicalId,version,String(sourceVersion.original_name),String(sourceVersion.original_name),String(sourceVersion.storage_object_id),String(sourceVersion.mime_type),Number(sourceVersion.size_bytes),String(sourceVersion.checksum_sha256),email,now]);
    rows.files.push([logicalId,taskId,String(folder.id),String(sourceVersion.original_name),"video",finalId,"pending_qc","project",email,now,now]);
    // Preserve the exact source version in this submission's material snapshot.
    selectedCategories.set(selectedFinalId,"video");
    statements.push(prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('production.final_promoted',?,?,?,?)").bind(email,finalId,JSON.stringify({submissionId:id,sourceVersionId:selectedFinalId}),now));
  }
  statements.push(insertRows(db,"project_files",["id","project_id","language_project_id","directory","original_name","storage_name","object_key","mime_type","size_bytes","version","uploader_email","status","source","created_at"],rows.pf),
    insertRows(db,"aigc_storage_objects",["id","provider","bucket_name","region_name","endpoint_url","object_key","etag","storage_class","created_at"],rows.storage),
    insertRows(db,"aigc_file_versions",["id","file_id","version_number","original_name","db_file_name","storage_object_id","mime_type","size_bytes","checksum_sha256","created_by","created_at"],rows.versions),
    insertRows(db,"aigc_files",["id","language_project_id","folder_id","display_name","file_kind","current_version_id","status","source","created_by","created_at","updated_at"],rows.files,true));
  const sceneSubmission = final ? await deseretSceneSubmission(db, String(task.project_id), taskId, finalId, payload.deseretScene, oldFinal ? String(oldFinal.current_version_id) : undefined) : null;
  // Its storyboard result is guarded by the stored project revision in the same transaction (guard below).
  if(final&&!note&&submissionNoteRequired({mode:"final",storyboard:Boolean(sceneSubmission?.storyboard),replacing}))throw new PublicError("Enter work notes and a valid progress percentage.");
  let archiveId:string|undefined,archivedSavedEngineering="";
  if(archive){
    // New uploads by the category they are committed under; saved versions by their real folder (never the form).
    const files=nativeArchiveFiles({ids,projectVersionId:String(payload.archiveProjectVersionId||""),previewVersionId:String(payload.archivePreviewVersionId||""),
      staged:staged.map(row=>({id:String(row.id),category:String(selectedCategories.get(String(row.id))),kind:String(row.file_kind)})),
      existing:existing.map(row=>({id:String(row.id),folderCode:String(row.category),kind:String(row.kind)}))});
    const recorded=archiveStatements(db,{projectId:String(task.project_id),taskId,email,now,nextSteps:String(payload.nextSteps||""),files});
    archiveId=recorded.id;statements.push(...recorded.statements);
    // A saved engineering version must still be filed under Project files when written (new uploads land there here).
    const engineering=files.find(file=>file.role==="project")!.id;
    if(existing.some(row=>String(row.id)===engineering))archivedSavedEngineering=engineering;
  }
  const checkpointId=directEdit?String(source!.id):id;
  const output={ok:true,submissionId:id,checkpointId:final||materials?undefined:checkpointId,finalVersionId:final?finalId:undefined,replacedVersionId:oldFinal?.current_version_id,...(materials?{fileIds:ids}:{}),...(archiveId?{archiveId}:{}), ...(sceneSubmission && existingData.deseret ? {deseretPhase: sceneSubmission.storyboard ? "storyboard" : "final"} : {})};
  if(final){
    if(oldFinal){
      statements.push(db.prepare("UPDATE project_files SET status='superseded' WHERE id=? AND status='pending_qc'").bind(oldFinal.current_version_id));
      if(String(oldFinal.file_id)!==String(priorFinal?.id))throw new PublicError("The pending final changed.",409,"FINAL_REPLACEMENT_CHANGED");
      statements.push(prepareAuditStatement(db,"INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('production.final_replaced',?,?,?,?)").bind(email,taskId,JSON.stringify({oldVersionId:oldFinal.current_version_id,newVersionId:finalId,reason:note}),now));
    }
    if(linkedReport)statements.push(db.prepare("UPDATE production_checkpoints SET attachment_schema=3,status=CASE WHEN status='ready' THEN 'frozen' ELSE status END,editable_until=NULL,frozen_at=COALESCE(frozen_at,?) WHERE id=?").bind(now,linkedReport.id));
    statements.push(db.prepare("INSERT INTO production_final_submissions(id,language_project_id,final_version_id,submitted_by,submitted_at,notes,daily_report_revision_id) VALUES(?,?,?,?,?,?,?)").bind(id,taskId,finalId,email,now,note,linkedReport?String(linkedReport.id):null),
      insertRows(db,"production_final_submission_files",["submission_id","file_version_id","category"],ids.filter(v=>v!==finalId).map(v=>[id,v,selectedCategories.get(v)!])),
      db.prepare("UPDATE project_files SET status='pending_qc' WHERE id=?").bind(finalId),
      db.prepare("UPDATE aigc_files SET status='pending_qc',updated_at=? WHERE current_version_id=?").bind(now,finalId),
      db.prepare("INSERT INTO notifications(id,recipient_email,type,title_zh,title_en,body_zh,body_en,target_type,target_id,is_read,created_at,actor_email,actor_name,actor_role,event_action) VALUES(?,?,'review',?,?,?,?,'language',?,0,?,?,?,'production',?)").bind(crypto.randomUUID(),task.reviewer_email,(sceneSubmission?.storyboard ? (replacing ? "待审分镜已替换" : "新分镜待质检") : (replacing?"待审成片已替换":"新成片待质检")),(sceneSubmission?.storyboard ? (replacing ? "Pending scene replaced" : "New storyboard scene awaiting review") : (replacing?"Pending final replaced":"New final awaiting review")),replacing?`${sceneSubmission?.storyboard ? "待审分镜" : "待审成片"}已替换：v${oldFinal?.version} → v${priorFinal?.next_version}。原因：${note}。请切换新版审核。`:`${task.project_name} · ${task.language}`,replacing?`Pending ${sceneSubmission?.storyboard ? "scene" : "final"} replaced: v${oldFinal?.version} → v${priorFinal?.next_version}. Reason: ${note}. Review the new version.`:`${task.project_name} · ${task.language}`,taskId,now,email,actor.name,replacing?"production.final_replaced":"production.submitted_qc"));
  }else if(!materials){
    const projectId=ids.find(v=>selectedCategories.get(v)==="project")||"",previewId=ids.find(v=>selectedCategories.get(v)==="video")||"";
    if(directEdit){
      statements.push(db.prepare("UPDATE production_checkpoints SET attachment_schema=2,completeness_status='complete',completed_work=?,notes=?,project_file_version_id=?,preview_file_version_id=?,file_count=?,updated_at=?,production_progress=?,completeness_json=? WHERE id=?").bind(note,note,projectId,previewId,ids.length,now,percent,JSON.stringify({workSummary:true,materialCount:ids.length}),checkpointId),db.prepare("DELETE FROM production_checkpoint_files WHERE checkpoint_id=?").bind(checkpointId),db.prepare("DELETE FROM task_material_links WHERE checkpoint_id=?").bind(checkpointId));
    }else{
    statements.push(db.prepare("INSERT INTO production_checkpoints(id,language_project_id,version_number,checkpoint_number,revision_number,editor_email,status,completeness_status,completeness_json,completed_work,notes,project_file_version_id,preview_file_version_id,file_count,created_at,updated_at,editable_until,attachment_schema,production_progress) SELECT ?,?,COALESCE(MAX(version_number),0)+1,COALESCE(MAX(checkpoint_number),0)+1,1,?,'ready','complete',?,?,?,?,?,?,?,?,?,2,? FROM production_checkpoints WHERE language_project_id=?")
      .bind(id,taskId,email,JSON.stringify({workSummary:true,materialCount:ids.length,handoverConfirmed:false}),note,note,projectId,previewId,ids.length,now,now,new Date(Date.now()+30*60000).toISOString(),percent,taskId),
      db.prepare("UPDATE production_checkpoints SET status='frozen',frozen_at=COALESCE(frozen_at,?) WHERE language_project_id=? AND id<>? AND status='ready'").bind(now,taskId,id));
    if(source){statements.push(db.prepare("UPDATE production_checkpoints SET checkpoint_number=?,revision_number=(SELECT next_revision FROM (SELECT COALESCE(MAX(revision_number),0)+1 AS next_revision FROM production_checkpoints WHERE language_project_id=? AND checkpoint_number=? AND id<>?) checkpoint_revisions),parent_checkpoint_id=?,supersedes_checkpoint_id=? WHERE id=?").bind(source.checkpoint_number,taskId,source.checkpoint_number,id,source.id,source.id,id),db.prepare("UPDATE production_checkpoints SET status='superseded',frozen_at=COALESCE(frozen_at,?),updated_at=? WHERE id=?").bind(now,now,source.id));}
    }
    if(daily)statements.push(db.prepare("UPDATE production_checkpoints SET attachment_schema=3,completeness_json=?,next_steps=?,editable_until=NULL WHERE id=?").bind(JSON.stringify({workDate,stage:payload.stage,workSummary:true,materialCount:ids.length}),payload.nextSteps||"",checkpointId));
    statements.push(insertRows(db,"production_checkpoint_files",["id","checkpoint_id","file_version_id","file_role","is_required","created_at"],ids.map(v=>[crypto.randomUUID(),checkpointId,v,selectedCategories.get(v)!,0,now])));
  }
  // A historical supplement must not replace more recent progress, including a later final submission.
  const lastFinal = daily ? await lastProductionFinal(db, taskId, existingData.deseret?.publishedFinalVersionIds) : null;
  const updateProgress=!materials&&(!daily||workDate>=String(reports[0]?.date||"")&&workDate>=reportDay(lastFinal?.at||(!reports.length?task.production_progress_at:null)||""));
  statements.push(sceneSubmission?.storyboard
    ? db.prepare("UPDATE language_projects SET status='待质检',updated_at=?,revision=revision+1 WHERE id=?").bind(now,taskId)
    : updateProgress?db.prepare("UPDATE language_projects SET production_progress=?,production_progress_note=?,production_progress_at=?,production_progress_by=?,status=CASE WHEN ?=1 THEN '待质检' WHEN status='待制作' THEN '制作中' ELSE status END,updated_at=?,revision=revision+1 WHERE id=?").bind(final?100:percent,note,now,email,final?1:0,now,taskId):db.prepare("UPDATE language_projects SET updated_at=?,revision=revision+1 WHERE id=?").bind(now,taskId),
    ...(!materials?[db.prepare("DELETE FROM production_checkpoint_drafts WHERE language_project_id=? AND editor_email=?").bind(taskId,email)]:[]),
    projectSummaryUpdateStatement(db,String(task.project_id)),
    db.prepare("UPDATE production_staged_files SET state='committed',committed_version_id=id,committed_submission_id=?,updated_at=? WHERE id IN(SELECT value FROM json_each(?))").bind(id,now,JSON.stringify(staged.map(f=>f.id))),
    prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES(?,?,?,?,?)").bind(archive?"production.deseret_archive_saved":materials?"production.materials_saved":final?"production.submitted_qc":daily?"production.daily_report_saved":directEdit?"production.checkpoint_edited":source?"production.checkpoint_corrected":"production.checkpoint_saved",email,checkpointId,materials?JSON.stringify({fileIds:ids}):note,now),
    db.prepare("INSERT INTO production_submission_receipts(id,actor_email,payload_hash,response_json,created_at) VALUES(?,?,?,?,?)").bind(id,email,hash,JSON.stringify(output),now));
  const guard=taskGuard(ctx,true,replacing,archive);
  if(archivedSavedEngineering){const folder=engineeringFolderGuard(archivedSavedEngineering,taskId);guard.sql+=` AND ${folder.sql}`;guard.values.push(...folder.values);}
  if(archive&&existing.length){
    const saved = savedArchiveVersionsGuard(existing.map(row => String(row.id)), taskId, String(task.project_id));
    guard.sql += ` AND ${saved.sql}`;
    guard.values.push(...saved.values);
  }
  if(sceneSubmission){
    guard.sql+=` AND ${sceneSubmission.sql}`;
    guard.values.push(...sceneSubmission.values);
    if (existingData.deseret) {
      guard.sql += " AND EXISTS(SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)";
      guard.values.push(String(task.project_id),existingData.deseret.revision);
    }
    statements.push(...sceneSubmission.statements);
  }
  if(oldFinal){
    guard.sql += ` AND EXISTS(SELECT 1 FROM aigc_files f JOIN project_files pf ON pf.id=f.current_version_id WHERE f.id=? AND f.current_version_id=? AND f.status='pending_qc' AND pf.status='pending_qc' AND ${liveLogicalFileSql("f")})`;
    guard.values.push(String(oldFinal.file_id),String(oldFinal.current_version_id));
  }
  if(advancedStageFiles.length){guard.sql+=` AND NOT EXISTS(SELECT 1 FROM json_each(?) prior WHERE NOT EXISTS(SELECT 1 FROM aigc_files f WHERE f.id=json_extract(prior.value,'$[0]') AND f.current_version_id=json_extract(prior.value,'$[1]') AND ${liveLogicalFileSql("f")}))`;guard.values.push(JSON.stringify(advancedStageFiles.map(prior=>[String(prior.id),String(prior.current_version_id)])));}
  if(flowStage){guard.sql+=` AND NOT EXISTS(SELECT 1 FROM json_each(?) item LEFT JOIN aigc_file_versions v ON v.id=item.value LEFT JOIN aigc_files f ON f.id=v.file_id WHERE f.current_version_id<>item.value OR f.language_project_id<>?)`;guard.values.push(JSON.stringify(existing.map(file=>file.id)),taskId);}
  // Recheck authorization in the same transaction as snapshot creation. Moving a
  // customer asset to a private folder must not resurrect an earlier selection.
  const readable=productionReadableVersionQuery(email);
  guard.sql+=` AND NOT EXISTS(SELECT 1 FROM json_each(?) requested WHERE requested.value NOT IN (${readable.sql}))`;
  guard.values.push(JSON.stringify(existing.map(f=>f.id)),...readable.values);
  if(priorFinal){guard.sql+=` AND EXISTS(SELECT 1 FROM aigc_files f JOIN aigc_folders folder ON folder.id=f.folder_id WHERE f.id=? AND f.current_version_id=? AND folder.folder_code='03.render.video' AND ${liveLogicalFileSql("f")})`;guard.values.push(String(priorFinal.id),String(priorFinal.current_version_id));}
  if(existingFinal){guard.sql+=` AND EXISTS(SELECT 1 FROM aigc_files f JOIN aigc_folders folder ON folder.id=f.folder_id JOIN project_files pf ON pf.id=f.current_version_id WHERE f.id=? AND f.current_version_id=? AND f.language_project_id=? AND f.file_kind='video' AND folder.folder_code=? AND f.status IN ('available','rejected','customer_revision_requested') AND pf.directory LIKE '03%' AND pf.status IN ('available','rejected','customer_revision_requested') AND ${liveLogicalFileSql("f")})`;guard.values.push(String(existingFinal.file_id),selectedFinalId,taskId,String(existingFinal.category));}
  if(source){guard.sql+=" AND EXISTS(SELECT 1 FROM production_checkpoints WHERE id=? AND updated_at=?)";guard.values.push(String(source.id),String(source.updated_at));}
  if(linkedReport){guard.sql+=" AND EXISTS(SELECT 1 FROM production_checkpoints WHERE id=? AND updated_at=? AND status NOT IN ('invalidated','failed'))";guard.values.push(String(linkedReport.id),String(linkedReport.updated_at));}
  if(directEdit){guard.sql+=" AND EXISTS(SELECT 1 FROM production_checkpoints WHERE id=? AND status='ready' AND editable_until>=?) AND NOT EXISTS(SELECT 1 FROM handover_records WHERE checkpoint_id=?)";guard.values.push(checkpointId,now,checkpointId);}
  try {
    await guardedMutation(db,`${guard.sql} AND NOT EXISTS(SELECT 1 FROM json_each(?) item LEFT JOIN production_staged_files s ON s.id=item.value WHERE s.id IS NULL OR s.state<>'ready' OR s.expires_at<=? OR s.actor_email<>? OR s.language_project_id<>?) AND NOT EXISTS(SELECT 1 FROM json_each(?) item LEFT JOIN project_files pf ON pf.id=item.value LEFT JOIN aigc_file_versions v ON v.id=item.value LEFT JOIN aigc_files f ON f.id=v.file_id WHERE pf.id IS NULL OR pf.deleted_at IS NOT NULL OR pf.status='deleted' OR NOT (${liveLogicalFileSql("f")})) AND NOT EXISTS(SELECT 1 FROM json_each(?) dest WHERE NOT (${liveFolderSql("dest.value")})) ${existingFinal?"AND EXISTS(SELECT 1 FROM aigc_files WHERE id=? AND current_version_id=?)":""} ${final?"AND NOT EXISTS(SELECT 1 FROM handover_records WHERE language_project_id=? AND status='pending') AND EXISTS(SELECT 1 FROM accounts WHERE email=? AND access_group='quality' AND status='active')":""}`,
      [...guard.values,JSON.stringify(staged.map(f=>f.id)),now,email,taskId,JSON.stringify(existing.map(f=>f.id)),JSON.stringify(destinations),...(existingFinal?[String(existingFinal.file_id),selectedFinalId]:[]),...(final?[taskId,String(task.reviewer_email)]:[])],statements);
  } catch(error) {
    const receipt=await db.prepare("SELECT response_json FROM production_submission_receipts WHERE id=? AND actor_email=? AND payload_hash=?").bind(id,email,hash).first<{response_json:string}>();
    if(receipt) return JSON.parse(receipt.response_json);
    throw error;
  }
  return output;
}
