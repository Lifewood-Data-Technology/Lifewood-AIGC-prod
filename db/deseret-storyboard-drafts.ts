import type { Database, DatabaseStatement } from "./database";
import { guardedMutation } from "./mutation-guard";
import { liveFolderSql, liveLogicalFileSql } from "./file-integrity";
import { productionReadableVersionQuery } from "./production-file-access";
import { previousProductionRender } from "./deseret-render-history";
import { prepareAuditStatement } from "./audit-write";
import { nextSceneVersion, type DeseretIntegrationState, type DeseretStoryboardDraft } from "../lib/deseret-workspace";
import { productionFileCategories } from "../lib/production-files";
import { PublicError } from "../lib/security-controls";
import { storageLocation } from "../lib/storage-location";

type Guard = { sql: string; values: (string | number | null)[] };
type Source = { id: string; original_name: string; object_key: string; storage_object_id: string; mime_type: string; size_bytes: number; checksum_sha256: string; etag: string };
type Context = {
  db: Database; taskId: string; projectId: string; email: string; actorName: string; reviewer: string;
  taskLabel: string; revision: number; guard: Guard;
  head: (key: string) => Promise<{ size: number; etag: string } | null>;
  summary: DatabaseStatement;
};

function conflict(message: string) { return new PublicError(message, 409, "DESERET_CONFLICT"); }
const sourceFolders = [...productionFileCategories.map(category => category.code), "03.render.video"];
function savedSourceQuery(ctx: Context, ids: string[]) {
  const access = productionReadableVersionQuery(ctx.email);
  return {
    sql: `FROM aigc_file_versions v JOIN aigc_files f ON f.current_version_id=v.id AND v.file_id=f.id
      JOIN aigc_folders folder ON folder.id=f.folder_id JOIN project_files pf ON pf.id=v.id
      JOIN aigc_storage_objects storage ON storage.id=v.storage_object_id
      WHERE pf.project_id=? AND pf.language_project_id=? AND f.language_project_id=? AND folder.language_project_id=?
      AND f.file_kind='video' AND v.mime_type LIKE 'video/%' AND folder.folder_code IN (SELECT value FROM json_each(?))
      AND pf.status IN ('available','rejected','customer_revision_requested') AND f.status IN ('available','rejected','customer_revision_requested')
      AND pf.directory LIKE '03%' AND pf.deleted_at IS NULL AND v.id IN (SELECT value FROM json_each(?))
      AND v.id IN (${access.sql})`,
    values: [ctx.projectId, ctx.taskId, ctx.taskId, ctx.taskId, JSON.stringify(sourceFolders), JSON.stringify(ids), ...access.values],
  };
}

async function destination(ctx: Context, code: string, guards: Guard[]) {
  const row = await ctx.db.prepare("SELECT id FROM aigc_folders WHERE language_project_id=? AND folder_code=? AND deleted_at IS NULL").bind(ctx.taskId, code).first<{ id: string }>();
  if (!row) throw conflict("The task video folder is unavailable.");
  guards.push({ sql: `EXISTS(SELECT 1 FROM aigc_folders folder WHERE folder.id=? AND folder.language_project_id=? AND folder.folder_code=? AND ${liveFolderSql("folder.id")})`, values: [row.id, ctx.taskId, code] });
  return row.id;
}

// Material drafts own their original bytes; each review version references those same bytes with an independent QC status.
function videoVersion(ctx: Context, source: Source, folder: string, id: string, logical: string, version: number, status: string, now: string, previous?: string) {
  const { db, projectId, taskId, email } = ctx;
  return [
    db.prepare("INSERT INTO project_files(id,project_id,language_project_id,directory,original_name,storage_name,object_key,mime_type,size_bytes,version,uploader_email,status,source,created_at) VALUES(?,?,?,'03_项目制作',?,?,?,?,?,?,?,?,'project',?)")
      .bind(id, projectId, taskId, source.original_name, source.original_name, source.object_key, source.mime_type, source.size_bytes, version, email, status, now),
    previous
      ? db.prepare("UPDATE aigc_files SET current_version_id=?,status=?,display_name=?,updated_at=? WHERE id=? AND current_version_id=?").bind(id, status, source.original_name, now, logical, previous)
      : db.prepare("INSERT INTO aigc_files(id,language_project_id,folder_id,display_name,file_kind,current_version_id,status,source,created_by,created_at,updated_at) VALUES(?,?,?,?,'video',?,?,'project',?,?,?)").bind(logical, taskId, folder, source.original_name, id, status, email, now, now),
    db.prepare("INSERT INTO aigc_file_versions(id,file_id,version_number,original_name,db_file_name,storage_object_id,mime_type,size_bytes,checksum_sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, logical, version, source.original_name, source.original_name, source.storage_object_id, source.mime_type, source.size_bytes, source.checksum_sha256, email, now),
  ];
}

async function prepareSources(ctx: Context, ids: string[], guards: Guard[]) {
  const query = savedSourceQuery(ctx, ids);
  const rows = (await ctx.db.prepare(`SELECT v.id,v.original_name,v.storage_object_id,v.mime_type,v.size_bytes,v.checksum_sha256,storage.object_key,storage.etag ${query.sql}`).bind(...query.values).all<Source>()).results;
  if (rows.length !== ids.length) throw conflict("A draft video is no longer available. Select a current task video.");
  guards.push({ sql: `(SELECT COUNT(*) ${query.sql})=?`, values: [...query.values, ids.length] });
  return new Map(rows.map(row => [row.id, row]));
}

async function saveSource(ctx: Context, id: string, requestId: string, now: string, guards: Guard[], statements: DatabaseStatement[]) {
  const condition = "id=? AND actor_email=? AND language_project_id=? AND ((purpose='materials' AND category='video') OR (purpose='final' AND category='final')) AND file_kind='video' AND state='ready' AND expires_at>?";
  const values = [id, ctx.email, ctx.taskId, now];
  const stage = await ctx.db.prepare(`SELECT * FROM production_staged_files WHERE ${condition}`).bind(...values).first<Source>();
  if (!stage) { await prepareSources(ctx, [id], guards); return; }

  const head = await ctx.head(stage.object_key);
  if (!head || head.size !== Number(stage.size_bytes)) throw conflict("The video upload is incomplete.");
  const folder = await destination(ctx, "03.preview", guards);
  guards.push({ sql: `EXISTS(SELECT 1 FROM production_staged_files WHERE ${condition})`, values });
  const location = storageLocation();
  const storageId = `production-${id}`;
  statements.push(
    ctx.db.prepare("INSERT INTO aigc_storage_objects(id,provider,bucket_name,region_name,endpoint_url,object_key,etag,storage_class,created_at) VALUES(?,?,?,?,?,?,?,'STANDARD',?)")
      .bind(storageId, location.provider, location.bucket, location.region, location.endpoint, stage.object_key, head.etag, now),
    ...videoVersion(ctx, { ...stage, storage_object_id: storageId }, folder, id, storageId, 1, "available", now),
    ctx.db.prepare("UPDATE production_staged_files SET state='committed',committed_version_id=id,committed_submission_id=?,updated_at=? WHERE id=?").bind(requestId, now, id),
  );
}

export function outstandingPublisherSceneIds(state: DeseretIntegrationState, taskId: string) {
  return state.scenes.filter(scene => {
    if (scene.languageTaskId !== taskId || !state.revisionSceneIds.includes(scene.id)) return false;
    const reviewed = state.packages.filter(pack => pack.phase === "storyboard" && !pack.withdrawn && pack.scenes.some(s => s.id === scene.id)).at(-1);
    return reviewed?.scenes.find(s => s.id === scene.id)?.fileVersionId === scene.fileVersionId;
  }).map(scene => scene.id);
}

export async function changeStoryboardDrafts(ctx: Context, payload: Record<string, string>, hash: string) {
  const { db, projectId, taskId, email } = ctx;
  const link = await db.prepare("SELECT state_json,revision FROM deseret_project_links WHERE id=?").bind(projectId).first<{ state_json: string; revision: number }>();
  if (!link || !payload.expectedRevision || Number(payload.expectedRevision) !== ctx.revision) throw conflict("Refresh the task before saving storyboard changes.");
  const state = JSON.parse(link.state_json) as DeseretIntegrationState;
  if (state.stage !== "production" || state.intake !== "accepted" || state.materials !== "ready") throw conflict("Storyboard production is not open.");
  const all = state.storyboardDrafts ??= [];
  const drafts = all.filter(draft => draft.languageTaskId === taskId);
  const scenes = state.scenes.filter(scene => scene.languageTaskId === taskId);
  const currentFiles = (await db.prepare("SELECT pf.id,pf.status,v.storage_object_id,v.checksum_sha256 FROM project_files pf JOIN aigc_file_versions v ON v.id=pf.id WHERE pf.project_id=? AND pf.language_project_id=? AND pf.deleted_at IS NULL AND pf.id IN (SELECT value FROM json_each(?))").bind(projectId, taskId, JSON.stringify(scenes.map(scene => scene.fileVersionId))).all<{ id: string; status: string; storage_object_id: string; checksum_sha256: string }>()).results;
  const statuses = new Map(currentFiles.map(row => [row.id, row.status]));
  const repair = new Set([...outstandingPublisherSceneIds(state, taskId), ...scenes.filter(scene => statuses.get(scene.fileVersionId) === "rejected").map(scene => scene.id)]);
  function checkTarget(draft: DeseretStoryboardDraft) {
    const previous = state.scenes.find(scene => scene.id === draft.sceneId);
    if (previous && previous.languageTaskId !== taskId || all.some(item => item.sceneId === draft.sceneId && item.languageTaskId !== taskId)) throw conflict("This scene belongs to another task.");
    if (draft.sceneVersion !== (previous?.version ?? 0)) throw conflict("This scene changed. Refresh the draft.");
    if ((repair.size || state.revisionSceneIds.length) && !repair.has(draft.sceneId)) throw conflict("Select a returned scene to revise.");
    if (previous && !repair.has(previous.id) && statuses.get(previous.fileVersionId) !== "available") throw conflict("Only a returned scene can be resubmitted.");
    if (previous && repair.has(previous.id) && previous.fileVersionId === draft.fileVersionId) throw conflict("Choose the new video for this revision.");
    if (previous && repair.has(previous.id) && !statuses.has(previous.fileVersionId)) throw conflict("The previous scene version is unavailable.");
  }
  const guards: Guard[] = [ctx.guard, { sql: "EXISTS(SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)", values: [projectId, Number(link.revision)] }];
  const writes: DatabaseStatement[] = [];
  const id = payload.submissionId, now = new Date().toISOString();
  const submitting = payload.kind === "storyboard_submit";
  const versionIds: string[] = [];
  if (!submitting) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(payload.sceneId || "")) throw new PublicError("Choose a storyboard scene.");
    const index = all.findIndex(d => d.languageTaskId === taskId && d.sceneId === payload.sceneId);
    if (payload.kind === "storyboard_remove") {
      if (index < 0) throw conflict("The draft has already changed.");
      all.splice(index, 1);
    } else if (payload.kind === "storyboard_draft") {
      const draft: DeseretStoryboardDraft = { languageTaskId: taskId, sceneId: payload.sceneId, sceneVersion: Number(payload.sceneVersion), duration: Number(payload.duration), fileVersionId: payload.fileVersionId };
      if (!payload.sceneVersion || !draft.fileVersionId || draft.fileVersionId.length > 120 || !Number.isFinite(draft.duration) || draft.duration <= 0 || draft.duration > 3600) throw new PublicError("Select a video and enter its duration (up to 3600 seconds).");
      checkTarget(draft);
      if (drafts.some(item => item.sceneId !== draft.sceneId && item.fileVersionId === draft.fileVersionId)) throw conflict("This video is already in the draft.");
      if (new Set([...state.scenes.map(scene => scene.id), ...all.map(item => item.sceneId), draft.sceneId]).size > 200) throw new PublicError("A storyboard package supports up to 200 scenes.");
      await saveSource(ctx, draft.fileVersionId, id, now, guards, writes);
      if (index >= 0) all[index] = draft;
      else all.push(draft);
    } else throw new PublicError("Unknown storyboard action.");
  } else {
    if (payload.materialsConfirmed !== "true" || !drafts.length) throw new PublicError("Confirm the storyboard drafts before submitting.");
    if (!ctx.reviewer) throw conflict("Assign a reviewer before submitting.");
    const folder = await destination(ctx, "03.render.video", guards);
    guards.push({ sql: "NOT EXISTS(SELECT 1 FROM handover_records WHERE language_project_id=? AND status='pending') AND EXISTS(SELECT 1 FROM accounts WHERE email=? AND access_group='quality' AND status='active') AND EXISTS(SELECT 1 FROM language_projects WHERE id=? AND reviewer_email=?)", values: [taskId, ctx.reviewer, taskId, ctx.reviewer] });
    const sources = await prepareSources(ctx, drafts.map(draft => draft.fileVersionId), guards);
    for (let start = 0; start < drafts.length; start += 8) {
      await Promise.all(drafts.slice(start, start + 8).map(async draft => {
        const source = sources.get(draft.fileVersionId)!;
        const head = await ctx.head(source.object_key);
        if (!head || head.size !== Number(source.size_bytes) || !source.etag || head.etag.replaceAll('"', "") !== source.etag.replaceAll('"', "")) throw conflict("A draft video is unavailable. Update it before submitting.");
      }));
    }
    const priorVersions: string[][] = [];
    for (const draft of drafts) {
      checkTarget(draft);
      const source = sources.get(draft.fileVersionId)!;
      const previous = state.scenes.find(scene => scene.id === draft.sceneId);
      const priorSource = previous && currentFiles.find(file => file.id === previous.fileVersionId);
      if (priorSource && repair.has(draft.sceneId) && (priorSource.storage_object_id === source.storage_object_id || priorSource.checksum_sha256 && priorSource.checksum_sha256 === source.checksum_sha256))
        throw conflict("Upload the revised video before resubmitting this scene.");
      const prior = previous ? await previousProductionRender(db, taskId, { phase: "storyboard", sceneVersionId: previous.fileVersionId }) : null;
      const reviewId = crypto.randomUUID(), submission = crypto.randomUUID();
      if (prior) priorVersions.push([String(prior.id), String(prior.current_version_id)]);
      writes.push(...videoVersion(ctx, source, folder, reviewId, prior ? String(prior.id) : `production-${reviewId}`, prior ? Number(prior.next_version) : 1, "pending_qc", now, prior ? String(prior.current_version_id) : undefined),
        db.prepare("INSERT INTO production_final_submissions(id,language_project_id,final_version_id,submitted_by,submitted_at,notes) VALUES(?,?,?,?,?,'')").bind(submission, taskId, reviewId, email, now),
        db.prepare("INSERT INTO production_final_submission_files(submission_id,file_version_id,category) VALUES(?,?,'video')").bind(submission, source.id));
      versionIds.push(reviewId);
      const scene = nextSceneVersion({ id: draft.sceneId, order: previous?.order ?? Math.max(0, ...state.scenes.map(s => s.order)) + 1, duration: draft.duration, characterIds: previous?.characterIds ?? [], voiceId: previous?.voiceId ?? "", fileVersionId: reviewId, languageTaskId: taskId }, previous, undefined);
      if (previous) state.scenes[state.scenes.indexOf(previous)] = scene;
      else state.scenes.push(scene);
    }
    if (priorVersions.length) guards.push({
      sql: `NOT EXISTS(SELECT 1 FROM json_each(?) prior WHERE NOT EXISTS(SELECT 1 FROM aigc_files f WHERE f.id=json_extract(prior.value,'$[0]') AND f.current_version_id=json_extract(prior.value,'$[1]') AND ${liveLogicalFileSql("f")}))`,
      values: [JSON.stringify(priorVersions)],
    });
    state.storyboardDrafts = all.filter(d => d.languageTaskId !== taskId);
    writes.push(db.prepare("INSERT INTO notifications(id,recipient_email,type,title_zh,title_en,body_zh,body_en,target_type,target_id,is_read,created_at,actor_email,actor_name,actor_role,event_action) VALUES(?,?,'review',?,?,?,?,'language',?,0,?,?,?,'production','production.submitted_qc')")
      .bind(crypto.randomUUID(), ctx.reviewer, `${drafts.length} 个分镜待质检`, `Storyboard review (${drafts.length})`, ctx.taskLabel, ctx.taskLabel, taskId, now, email, ctx.actorName));
  }
  state.revision = Number(link.revision) + 1;
  const result = { ok: true, submissionId: id, ...(submitting ? { fileVersionIds: versionIds, deseretPhase: "storyboard" } : {}) };
  writes.push(
    db.prepare("UPDATE deseret_project_links SET state_json=?,revision=revision+1,updated_at=? WHERE id=?").bind(JSON.stringify(state), now, projectId),
    db.prepare("UPDATE language_projects SET revision=revision+1,updated_at=?,status=CASE WHEN ?=1 THEN '待质检' ELSE status END WHERE id=?").bind(now, submitting ? 1 : 0, taskId),
    ...(submitting ? [ctx.summary] : []),
    prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES(?,?,?,?,?)").bind("production." + payload.kind, email, taskId, JSON.stringify({ submissionId: id, sceneIds: submitting ? drafts.map(d => d.sceneId) : [payload.sceneId] }), now),
    db.prepare("INSERT INTO production_submission_receipts(id,actor_email,payload_hash,response_json,created_at) VALUES(?,?,?,?,?)").bind(id, email, hash, JSON.stringify(result), now));
  try {
    await guardedMutation(db, guards.map(g => `(${g.sql})`).join(" AND "), guards.flatMap(g => g.values), writes);
  } catch (error) {
    const replay = await db.prepare("SELECT response_json FROM production_submission_receipts WHERE id=? AND actor_email=? AND payload_hash=?").bind(id, email, hash).first<{ response_json: string }>();
    if (replay) return JSON.parse(replay.response_json);
    throw error;
  }
  return result;
}
