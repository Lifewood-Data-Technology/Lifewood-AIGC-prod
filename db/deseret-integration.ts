import { finalSubmissionEvidenceSql } from "./deseret-final-provenance";
import { isStoryboardFileVersion, scopeDeseretReview } from "../lib/deseret-workspace";
import { createHash, randomUUID } from "node:crypto";
import type { Database, DatabaseStatement } from "./database";
import { guardedMutation } from "./mutation-guard";
import { prepareAuditStatement } from "./audit-write";
import { PublicError } from "../lib/security-controls";
import { progressEditableStatuses } from "../lib/task-file-access";
import { validCalendarDate } from "../lib/employee-workflow";
import { approvedFileIds, approvedSceneCharacters, producerBoundValue, producerBoundValues, producerDurationSeconds, versionedProductionLanguage } from "../lib/deseret-producer-brief";
import { integrationBodyHash, validateHandoffManifest, type HandoffMaterial, type IntegrationConfig, type IntegrationEnvelope } from "../lib/deseret-integration-contract";
import type { DeseretFeedback, DeseretIntegrationState, DeseretPublishedFile, DeseretReviewPackage, DeseretScene, DeseretWorkspace } from "../lib/deseret-workspace";

type Row = Record<string, unknown>;
export type IntegrationProjectContext = {
  db: Database;
  actor: { email: string; access: string };
  project: Row;
  access: { sql: string; values: (string | number | null)[] };
};
export type NativeProjectCreated = { db: Database; projectId: string; videoIds: string[]; languageIds: string[]; requestId: string; now: string };
export type IntegrationNativeFile = {
  id: string; version: number; name: string; languageTaskId: string; size: number; mimeType: string;
  sha256: string; qualityPassed: boolean; finalSubmission: boolean; storageReady: boolean;
  objectKey: string; storageProfileId: string; etag: string;
};
export type IntegrationDependencies = {
  db: Database;
  config: IntegrationConfig;
  createNativeProject(payload: Record<string, string>, commit: (input: NativeProjectCreated) => DatabaseStatement[]): Promise<unknown>;
  projectContext(email: string, projectId: string, write: boolean): Promise<IntegrationProjectContext>;
  serviceProjectContext(projectId: string): Promise<IntegrationProjectContext>;
  nativeFiles(context: IntegrationProjectContext, fileIds?: string[]): Promise<IntegrationNativeFile[]>;
  verifyNativeFiles(files: IntegrationNativeFile[]): Promise<void>;
  projectSummaryStatement?: (projectId: string) => DatabaseStatement;
  clock?: () => number;
};

const identity = /^[A-Za-z0-9_-]{1,120}$/;
const text = (value: unknown, maximum = 2000): value is string => typeof value === "string" && value.length <= maximum;
const object = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value));
function reject(message: string, code = "DESERET_INVALID", status = 400): never { throw new PublicError(message, status, code); }
function initialState(materialsReady = false): DeseretIntegrationState {
  return { stage: "intake", intake: "pending", revision: 1, materials: materialsReady ? "ready" : "waiting_transfer", scenes: [], packages: [], feedback: [], authorFeedback: [], revisionSceneIds: [] };
}
export function readDeseretState(row: Row): DeseretIntegrationState {
  const value = JSON.parse(String(row.state_json));
  if (!object(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.scenes) || !Array.isArray(value.packages) || !Array.isArray(value.feedback) || !Array.isArray(value.authorFeedback))
    reject("Stored integration state requires reconciliation.", "DESERET_STATE_INVALID", 409);
  return value as DeseretIntegrationState;
}
function materialId(projectId: string, sourceRevision: string, file: HandoffMaterial, direction: string, packageId = "") {
  return createHash("sha256").update(JSON.stringify([projectId, sourceRevision, direction, packageId, file.id, file.version])).digest("hex");
}
export function deseretOutboxStatement(db: Database, projectId: string, externalId: string, sourceRevision: string, type: IntegrationEnvelope["type"], payload: Row, at: string) {
  const envelope: IntegrationEnvelope = { schemaVersion: 1, eventId: randomUUID(), type, projectId: externalId, sourceRevision, occurredAt: at, payload: { ...payload, aigcProjectId: projectId } };
  return db.prepare("INSERT INTO deseret_outbox (id,project_id,source_revision,event_type,body_json,state,attempts,lease_id,lease_expires_at,next_attempt_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,'pending',0,NULL,NULL,?,NULL,?,?)")
    .bind(envelope.eventId, projectId, sourceRevision, type, JSON.stringify(envelope), at, at, at);
}
function materialStatements(db: Database, projectId: string, sourceRevision: string, files: HandoffMaterial[], at: string, direction = "deseret_to_aigc", packageId = "") {
  const rows = files.map(file => [materialId(projectId, sourceRevision, file, direction, packageId), projectId, sourceRevision, file.id, file.version, JSON.stringify(file), direction, packageId || null, at, at]);
  return rows.length ? [db.prepare("INSERT OR IGNORE INTO deseret_material_tasks (id,project_id,source_revision,file_id,file_version,manifest_json,direction,package_id,target_json,state,attempts,last_error,lease_id,lease_expires_at,next_attempt_at,created_at,updated_at) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),json_extract(value,'$[6]'),json_extract(value,'$[7]'),NULL,'pending',0,NULL,NULL,NULL,json_extract(value,'$[8]'),json_extract(value,'$[8]'),json_extract(value,'$[9]') FROM json_each(?)").bind(JSON.stringify(rows))] : [];
}
function responseStatement(db: Database, id: string, sender: string, projectId: string, hash: string, response: Row, at: string) {
  return db.prepare("INSERT INTO deseret_inbox (id,sender,project_id,payload_hash,state,response_json,created_at,updated_at) VALUES (?,?,?,?,'complete',?,?,?)")
    .bind(id, sender, projectId, hash, JSON.stringify(response), at, at);
}
async function previousResponse(db: Database, id: string, sender: string, hash: string): Promise<Row | undefined> {
  const row = await db.prepare("SELECT sender,payload_hash,response_json,state FROM deseret_inbox WHERE id=?").bind(id).first<Row>();
  if (!row) return;
  if (row.sender !== sender || row.payload_hash !== hash) reject("Integration event identity mismatch.", "DESERET_REPLAY_CONFLICT", 409);
  if (row.state !== "complete") reject("Integration event is awaiting reconciliation.", "DESERET_UNCONFIRMED", 409);
  return JSON.parse(String(row.response_json));
}

export function productionRequirements(brief: unknown, fallbackTitle: string) {
  const source = object(brief) ? brief : {};
  const project = object(source.project) ? source.project : {};
  const creative = object(source.creative) ? source.creative : {};
  const paragraphs = [...producerBoundValues(source,"book.synopsis", source.story), producerBoundValue(source,"project.conceptNotes"),
    ...producerBoundValues(source,"direction.coreMessage", project.coreMessage, creative.coreMessage),
    producerBoundValue(source,"direction.requiredScenes"), producerBoundValue(source,"direction.authorPreferences"),
    producerBoundValue(source,"direction.avoidContent"), producerBoundValue(source,"direction.closingMessage"),
    producerBoundValue(source,"direction.vision"), producerBoundValue(source,"book.sellingPoint")]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(value => value.trim());
  return [...new Set(paragraphs)].join("\n\n") || fallbackTitle;
}

export function readableDeseretRequirements(value: unknown, snapshots: unknown[]) {
  if (typeof value !== "string") return value;
  const known = snapshots.find(snapshot => object(snapshot) && object(snapshot.brief) && JSON.stringify(snapshot.brief) === value);
  if (!object(known)) return value;
  const project = object(known.project) ? known.project : {};
  return productionRequirements(known.brief, typeof project.title === "string" ? project.title : "");
}

function serviceAuditStatement(db: Database, projectId: string, envelope: IntegrationEnvelope, effectiveOwner: string, at: string) {
  return prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('integration.deseret_received','service:deseret',?,?,?)")
    .bind(projectId, JSON.stringify({ eventId: envelope.eventId, type: envelope.type, sourceRevision: envelope.sourceRevision, effectiveOwner }), at);
}

function currentStoryboardApproved(state: DeseretIntegrationState, taskId: string) {
  const latest = state.packages.filter(pack => pack.phase === "storyboard" && !pack.withdrawn &&
    pack.scenes.some(scene => scene.languageTaskId === taskId)).at(-1);
  if (latest?.conclusion !== "approved") return false;
  const approved = new Map(latest.scenes.filter(scene => scene.languageTaskId === taskId).map(scene => [scene.id, scene]));
  const current = state.scenes.filter(scene => scene.languageTaskId === taskId);
  return current.length > 0 && approved.size === current.length && current.every(scene => {
    const prior = approved.get(scene.id);
    return prior && scene.version === prior.version && scene.fileVersionId === prior.fileVersionId && scene.order === prior.order;
  });
}

function previouslyPublishedFinal(state: DeseretIntegrationState, file: IntegrationNativeFile) {
  return state.packages.some(pack => pack.phase === "final" &&
    pack.files.some(item => item.fileVersionId === file.id && item.languageTaskId === file.languageTaskId));
}

export function createDeseretIntegrationService(deps: IntegrationDependencies) {
  const { db, config } = deps;
  const now = () => new Date((deps.clock || Date.now)()).toISOString();
  function enabled() { if (!config.enabled) reject("Deseret integration is disabled.", "DESERET_DISABLED", 503); }
  async function link(externalId: string) {
    const row = await db.prepare("SELECT * FROM deseret_project_links WHERE deseret_project_id=?").bind(externalId).first<Row>();
    if (!row) reject("The integration project is unavailable.", "DESERET_PROJECT_UNAVAILABLE", 404);
    return row;
  }
  async function handoff(envelope: IntegrationEnvelope, rawBody: string) {
    enabled();
    const deletionJobs = (await db.prepare("SELECT summary_json FROM business_deletion_jobs WHERE state IN ('pending','running','failed','complete') AND instr(summary_json,json_quote(?))>0").bind(envelope.projectId).all<{ summary_json: string }>()).results;
    if (deletionJobs.some(job => {
      const summary = JSON.parse(job.summary_json) as { deseretProjectIds?: { externalId: string }[] };
      return summary.deseretProjectIds?.some(project => project.externalId === envelope.projectId);
    })) reject("This integration project has been permanently deleted.", "DESERET_PROJECT_DELETED", 410);
    const validated = validateHandoffManifest(envelope.payload.files);
    const hash = integrationBodyHash(rawBody);
    const replay = await previousResponse(db, envelope.eventId, "deseret", hash);
    if (replay) return replay;
    const payload = envelope.payload;
    const approvedIds = approvedFileIds(payload.brief);
    if (approvedIds && (validated.length !== approvedIds.size || validated.some(file => !approvedIds.has(file.id)) ||
        new Set(validated.map(file => file.id)).size !== validated.length))
      reject("The file list must match the approved answers.", "DESERET_BRIEF_FILES_MISMATCH", 422);
    const project = payload.project as Row;
    if (!Array.isArray(project.languageCodes) || project.languageCodes.length !== 1) reject("This integration handoff requires one approved content language.", "DESERET_LANGUAGE_SCOPE_UNSUPPORTED", 422);
    const language = versionedProductionLanguage(payload.brief) ??
      (object(payload.brief) ? payload.brief.publisherProductionLanguage : undefined);
    if (language !== undefined && language !== project.languageCodes[0])
      reject("The task language must match the publisher selection.", "DESERET_LANGUAGE_MISMATCH", 422);
    const requirements = productionRequirements(payload.brief, String(project.title));
    const durationSeconds = producerDurationSeconds(payload.brief);
    const version = Number(payload.submissionVersion);
    const at = now();
    const due = typeof project.dueDate === "string" ? project.dueDate : new Date(Date.parse(at) + config.intakeDueDays * 86400000).toISOString().slice(0, 10);
    if (!validCalendarDate(due)) reject("A valid production due date is required.");
    const existing = await db.prepare("SELECT * FROM deseret_project_links WHERE deseret_project_id=?").bind(envelope.projectId).first<Row>();
    if (existing) {
      const state = readDeseretState(existing);
      if (state.intake !== "needsSupplement" || state.packages.length || version <= Number(existing.submission_version))
        reject("A newer approved submission requires an explicit supplemental request.", "DESERET_SOURCE_CONFLICT", 409);
      const context = await deps.serviceProjectContext(String(existing.id));
      const taskRows = (await db.prepare("SELECT id,video_id,language_code FROM language_projects WHERE project_id=? AND status<>'已终止' ORDER BY id").bind(existing.id).all<Row>()).results;
      const actualLanguages = [...new Set(taskRows.map(task => String(task.language_code)))].sort();
      const requestedLanguages = [...new Set(project.languageCodes as string[])].sort();
      if (JSON.stringify(actualLanguages) !== JSON.stringify(requestedLanguages)) reject("Align the native project's language tasks with the approved language selection, then retry this handoff.", "DESERET_LANGUAGE_CHANGE_REQUIRED", 422);
      const next = { ...initialState(validated.length === 0), revision: state.revision + 1 };
      const videoIds = [...new Set(taskRows.map(task => String(task.video_id)))];
      const taskIds = taskRows.map(task => String(task.id));
      const nextDue = typeof project.dueDate === "string" ? due : String(context.project.due_date);
      const response = { accepted: true, eventId: envelope.eventId, aigcProjectId: existing.id, sourceRevision: envelope.sourceRevision };
      await guardedMutation(db, `${context.access.sql} AND EXISTS (SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)`, [...context.access.values, String(existing.id), Number(existing.revision)], [
        db.prepare("UPDATE deseret_project_links SET source_revision=?,submission_version=?,snapshot_json=?,state_json=?,native_video_ids=?,native_task_ids=?,revision=revision+1,updated_at=? WHERE id=?").bind(envelope.sourceRevision, version, JSON.stringify(payload), JSON.stringify(next), JSON.stringify(videoIds), JSON.stringify(taskIds), at, existing.id),
        db.prepare("INSERT INTO deseret_handoff_history(id,project_id,source_revision,submission_version,snapshot_json,received_at) VALUES(?,?,?,?,?,?)").bind(randomUUID(), existing.id, envelope.sourceRevision, version, JSON.stringify(payload), at),
        db.prepare("UPDATE deseret_material_tasks SET state='superseded',updated_at=? WHERE project_id=? AND direction='deseret_to_aigc' AND state<>'ready'").bind(at, existing.id),
        db.prepare("UPDATE deseret_outbox SET state='superseded',updated_at=? WHERE project_id=? AND source_revision<>? AND state<>'delivered'").bind(at, existing.id, envelope.sourceRevision),
        db.prepare("UPDATE projects SET specification=?,due_date=?,updated_at=?,revision=revision+1 WHERE id=?").bind(requirements, nextDue, at, existing.id),
        ...(producerBoundValue(payload.brief,"book.videoDurationId") !== undefined && videoIds.length === 1 ? [db.prepare("UPDATE project_videos SET duration_seconds=?,updated_at=? WHERE id=? AND project_id=?").bind(durationSeconds ?? null,at,videoIds[0],existing.id)] : []),
        db.prepare("UPDATE language_projects SET requirements=?,due_date=?,updated_at=?,revision=revision+1 WHERE project_id=? AND status NOT IN ('已交付','已归档','已终止')").bind(requirements, nextDue, at, existing.id),
        ...materialStatements(db, String(existing.id), envelope.sourceRevision, validated, at),
        responseStatement(db, envelope.eventId, "deseret", String(existing.id), hash, response, at),
        serviceAuditStatement(db, String(existing.id), envelope, context.actor.email, at),
        deseretOutboxStatement(db, String(existing.id), envelope.projectId, envelope.sourceRevision, "project.accepted", { videoIds, languageTaskIds: taskIds, submissionVersion: version, intakeState: "pending" }, at),
        ...(validated.length ? [] : [deseretOutboxStatement(db, String(existing.id), envelope.projectId, envelope.sourceRevision, "materials.ready", { direction: "deseret_to_aigc" }, at)]),
      ]);
      return response;
    }
    const state = initialState(validated.length === 0);
    let response: Row | undefined;
    try {
      const reference = createHash("sha256").update(envelope.projectId).digest("hex").slice(0, 12);
      const nativeTitle = Array.from(String(project.title), character => {
        const code = character.codePointAt(0)!;
        return code < 32 || (code >= 127 && code <= 159) || code === 8232 || code === 8233 ? " " : character;
      }).join("").trim().slice(0, 60).replace(/[\uD800-\uDBFF]$/, "");
      await deps.createNativeProject({ clientId: config.clientId, name: `${nativeTitle} · DB-${reference}`, requirements, dueDate: due, languages: JSON.stringify(project.languageCodes), priority: "standard",
        ...(durationSeconds !== undefined ? {videos:JSON.stringify([{name:nativeTitle,brief:requirements,dueDate:due,languages:project.languageCodes,durationSeconds}])} : {}) }, input => {
        response = { accepted: true, eventId: envelope.eventId, aigcProjectId: input.projectId, sourceRevision: envelope.sourceRevision };
        return [
          db.prepare("INSERT INTO deseret_project_links (id,deseret_project_id,source_revision,submission_version,snapshot_json,state_json,native_video_ids,native_task_ids,revision,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)")
            .bind(input.projectId, envelope.projectId, envelope.sourceRevision, version, JSON.stringify(payload), JSON.stringify(state), JSON.stringify(input.videoIds), JSON.stringify(input.languageIds), config.intakeOwnerEmail, at, at),
          db.prepare("INSERT INTO deseret_handoff_history(id,project_id,source_revision,submission_version,snapshot_json,received_at) VALUES(?,?,?,?,?,?)").bind(randomUUID(), input.projectId, envelope.sourceRevision, version, JSON.stringify(payload), at),
          ...materialStatements(db, input.projectId, envelope.sourceRevision, validated, at),
          responseStatement(db, envelope.eventId, "deseret", input.projectId, hash, response, at),
          serviceAuditStatement(db, input.projectId, envelope, config.intakeOwnerEmail, at),
          deseretOutboxStatement(db, input.projectId, envelope.projectId, envelope.sourceRevision, "project.accepted", { aigcProjectId: input.projectId, videoIds: input.videoIds, languageTaskIds: input.languageIds, submissionVersion: version, intakeState: "pending" }, at),
          ...(validated.length ? [] : [deseretOutboxStatement(db, input.projectId, envelope.projectId, envelope.sourceRevision, "materials.ready", { direction: "deseret_to_aigc" }, at)]),
        ];
      });
    } catch (error) {
      const duplicate = await previousResponse(db, envelope.eventId, "deseret", hash);
      if (duplicate) return duplicate;
      throw error;
    }
    if (!response) reject("Native project creation did not commit the integration mapping.", "DESERET_UNCONFIRMED", 409);
    return response;
  }

  async function receive(envelope: IntegrationEnvelope, rawBody: string) {
    enabled();
    if (!["review.concluded", "review.feedback", "author.feedback"].includes(envelope.type)) reject("Unsupported integration event.");
    const hash = integrationBodyHash(rawBody);
    const replay = await previousResponse(db, envelope.eventId, "deseret", hash);
    if (replay) return replay;
    const row = await link(envelope.projectId);
    if (row.source_revision !== envelope.sourceRevision) reject("The production source revision changed.", "DESERET_SOURCE_CONFLICT", 409);
    const context = await deps.serviceProjectContext(String(row.id));
    const state = readDeseretState(row);
    const payload = envelope.payload;
    const pack = state.packages.find(item => item.id === payload.packageId && !item.withdrawn);
    if (!pack || !pack.filesReady || (payload.packageVersion !== undefined ? pack.version !== payload.packageVersion : envelope.type !== "author.feedback")) reject("The review publication is unavailable.", "DESERET_PACKAGE_CONFLICT", 409);
    if (envelope.type === "review.concluded") {
      const reviewedTaskIds = [...new Set(pack.files.map(file => file.languageTaskId))];
      const reviewedTasks = (await db.prepare("SELECT id,status FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?))").bind(row.id, JSON.stringify(reviewedTaskIds)).all<Row>()).results;
      if (reviewedTasks.some(task => ["已交付", "已归档", "已终止"].includes(String(task.status)))) reject("The production task is closed.", "delivery_locked", 409);
      if (reviewedTasks.some(task => task.status === "已暂停")) reject("Resume the paused production task before applying the review conclusion.", "DESERET_TASK_PAUSED", 503);
      const authorRevision = payload.conclusion === "revision" && typeof payload.authorFeedbackId === "string" && state.authorFeedback.some(comment => comment.id === payload.authorFeedbackId && comment.packageId === pack.id) && state.stage === "delivery" && pack.phase === "final" && pack.conclusion === "approved";
      const packageTaskIds = [...new Set(pack.files.map(file => file.languageTaskId))];
      const latestFinal = packageTaskIds.every(taskId => state.packages.filter(item => item.phase === "final" && !item.withdrawn && item.files.some(file => file.languageTaskId === taskId)).at(-1)?.id === pack.id);
      if (authorRevision && !latestFinal) reject("A newer final publication exists.", "DESERET_PACKAGE_CONFLICT", 409);
      const deliveredTask = authorRevision && await db.prepare("SELECT id FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('已交付','已归档','已终止') LIMIT 1").bind(row.id, JSON.stringify(packageTaskIds)).first();
      if (authorRevision && deliveredTask) reject("The final has already been delivered.", "delivery_locked", 409);
      if (envelope.type === "review.concluded" && (state.stage === "archived" || ["已归档", "已终止"].includes(String(context.project.status)))) reject("The project is closed.", "delivery_locked", 409);
      if (authorRevision && (state.deliveryLocked || ["已交付", "已归档", "已终止"].includes(String(context.project.status)))) reject("The production has already been delivered or closed.", "delivery_locked", 409);
      if ((pack.conclusion && !authorRevision) || !["approved", "revision"].includes(String(payload.conclusion))) reject("This review round is already closed.", "DESERET_ROUND_CLOSED", 409);
      const decisions = payload.decisions;
      if (!Array.isArray(decisions) || decisions.length !== pack.scenes.length || pack.scenes.some(scene => !decisions.some(decision => object(decision) && decision.sceneId === scene.id && decision.sceneVersion === scene.version && ["approved", "revision"].includes(String(decision.decision))))) reject("Every scene requires an exact-version review decision.");
      const changed = decisions.filter(decision => object(decision) && decision.decision === "revision").map(decision => String(decision.sceneId));
      if ((payload.conclusion === "approved") !== (changed.length === 0)) reject("The round conclusion does not match its scene decisions.");
      if (authorRevision && object(payload.authorFeedback) && object(payload.authorFeedback.processing)) {
        const processing = payload.authorFeedback.processing;
        if (processing.decision !== "revision_requested" || !text(processing.note) || !text(processing.processedBy, 120) || !text(processing.processedAt, 64) || !Number.isFinite(Date.parse(processing.processedAt))) reject("Invalid author feedback processing record.");
        state.authorFeedback.find(comment => comment.id === payload.authorFeedbackId)!.processing = { decision: "revision_requested", note: processing.note, processedBy: processing.processedBy, processedAt: processing.processedAt };
      }
      if (!authorRevision) pack.conclusion = payload.conclusion as "approved" | "revision";
      state.revisionSceneIds = changed;
      const taskIds = JSON.parse(String(row.native_task_ids)) as string[];
      const finalApproved = taskIds.every(taskId => state.packages.filter(item => item.phase === "final" && !item.withdrawn && item.files.some(file => file.languageTaskId === taskId)).at(-1)?.conclusion === "approved");
      state.stage = changed.length ? "revision" : pack.phase === "storyboard" || !finalApproved ? "final_production" : "delivery";
    } else {
      const actor = payload.actorId ?? payload.authorId;
      if (!text(payload.body) || !text(actor, 120) || !actor) reject("Feedback requires valid content and an actor reference.");
      const corrections: Record<string, string> = {};
      if (payload.corrections !== undefined) {
        if (!object(payload.corrections)) reject("Invalid correction details.");
        for (const [key, value] of Object.entries(payload.corrections)) {
          if (!["en", "zh", "text", "pronunciation", "extra"].includes(key) || !text(value)) reject("Invalid correction details.");
          corrections[key] = value;
        }
      }
      const guidance = validateHandoffManifest(payload.files || []);
      if (guidance.length > 3 || (!payload.body.trim() && !Object.values(corrections).some(value => value.trim()) && !guidance.length)) reject("Feedback requires text, a correction or a registered guidance file.");
      for (const file of guidance) {
        const previous = await db.prepare("SELECT manifest_json FROM deseret_material_tasks WHERE id=?").bind(materialId(String(row.id), String(row.source_revision), file, "deseret_to_aigc", pack.id)).first<{ manifest_json: string }>();
        if (previous && previous.manifest_json !== JSON.stringify(file)) reject("The guidance file identity changed.", "DESERET_MEDIA_IDENTITY_CHANGED", 409);
      }
      if (payload.mode !== undefined && !["comment", "time", "revision", "flag"].includes(String(payload.mode))) reject("Invalid feedback mode.");
      if (payload.targets !== undefined && (!Array.isArray(payload.targets) || payload.targets.length > 4 || payload.targets.some(target => !["script", "visuals", "voice", "timing"].includes(String(target))))) reject("Invalid revision targets.");
      if (envelope.type === "author.feedback" && (pack.phase !== "final" || pack.conclusion !== "approved")) reject("Author feedback requires an approved final.", "DESERET_ROUND_CLOSED", 409);
      const feedback: DeseretFeedback = { id: typeof payload.id === "string" && identity.test(payload.id) ? payload.id : envelope.eventId, type: envelope.type as "review.feedback" | "author.feedback", packageId: pack.id, body: payload.body.trim(), actorId: actor, createdAt: envelope.occurredAt };
      if (payload.mode !== undefined) feedback.mode = payload.mode as DeseretFeedback["mode"];
      if (payload.targets !== undefined) feedback.targets = payload.targets as string[];
      if (Object.keys(corrections).length) feedback.corrections = corrections;
      if (guidance.length) feedback.files = guidance;
      if (payload.sceneId !== undefined) {
        if (!pack.scenes.some(scene => scene.id === payload.sceneId)) reject("Feedback scene is outside this publication.");
        feedback.sceneId = String(payload.sceneId);
      }
      if (payload.seconds !== undefined) {
        const scene = pack.scenes.find(item => item.id === feedback.sceneId);
        if (!scene || typeof payload.seconds !== "number" || !Number.isFinite(payload.seconds) || payload.seconds < 0 || payload.seconds > scene.duration) reject("Feedback timecode is outside the scene.");
        feedback.seconds = payload.seconds;
      }
      (envelope.type === "author.feedback" ? state.authorFeedback : state.feedback).push(feedback);
    }
    state.revision += 1;
    const at = now();
    const response = { accepted: true, eventId: envelope.eventId };
    await guardedMutation(db, `${context.access.sql} AND EXISTS (SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)${envelope.type === "review.concluded" ? " AND NOT EXISTS(SELECT 1 FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('已暂停','已交付','已归档','已终止'))" : ""}`, [...context.access.values, String(row.id), Number(row.revision), ...(envelope.type === "review.concluded" ? [String(row.id), JSON.stringify([...new Set(pack.files.map(file => file.languageTaskId))])] : [])], [
      db.prepare("UPDATE deseret_project_links SET state_json=?,revision=revision+1,updated_at=? WHERE id=?").bind(JSON.stringify(state), at, row.id),
      ...(envelope.type === "review.concluded" ? [db.prepare("UPDATE language_projects SET status=?,updated_at=?,revision=revision+1 WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status NOT IN ('已交付','已归档','已终止')").bind(pack.phase === "final" && payload.conclusion === "approved" ? "待交付" : "制作中", at, row.id, JSON.stringify([...new Set(pack.files.map(file => file.languageTaskId))]))] : []),
      ...(envelope.type === "review.concluded" && deps.projectSummaryStatement ? [deps.projectSummaryStatement(String(row.id))] : []),
      responseStatement(db, envelope.eventId, "deseret", String(row.id), hash, response, at),
      serviceAuditStatement(db, String(row.id), envelope, context.actor.email, at),
      ...(envelope.type === "review.feedback" ? materialStatements(db, String(row.id), String(row.source_revision), validateHandoffManifest(payload.files || []), at, "deseret_to_aigc", pack.id) : []),
    ]);
    return response;
  }

  async function workspace(email: string, projectId: string): Promise<DeseretWorkspace> {
    enabled();
    const context = await deps.projectContext(email, projectId, false);
    const row = await db.prepare("SELECT * FROM deseret_project_links WHERE id=?").bind(projectId).first<Row>();
    if (!row) reject("This project uses the standard production workflow.", "DESERET_PROJECT_UNAVAILABLE", 404);
    const state = readDeseretState(row);
    const role = context.actor.access === "project" ? "lead" : context.actor.access === "production" ? "producer" : "qc";
    const taskRows = (await db.prepare("SELECT * FROM language_projects WHERE project_id=? ORDER BY id").bind(projectId).all<Row>()).results.filter(task => role === "lead" || task[role === "producer" ? "editor_email" : "reviewer_email"] === email);
    const taskIds = new Set(taskRows.map(task => String(task.id)));
    const candidates = await deps.nativeFiles(context);
    const referencedFiles = await deps.nativeFiles(context, [
      ...state.scenes.map(scene => scene.fileVersionId),
      ...state.packages.filter(pack => pack.phase === "final").flatMap(pack => pack.files.map(file => file.fileVersionId)),
    ]);
    const files = [...new Map([...candidates, ...referencedFiles].map(file => [file.id, file])).values()];
    const materials = (await db.prepare("SELECT id,package_id,manifest_json,state FROM deseret_material_tasks WHERE project_id=? AND source_revision=? AND direction='deseret_to_aigc'").bind(projectId, row.source_revision).all<Row>()).results;
    // Resolve exact registration receipts, never guess a version by filename or object key.
    const receiptIds = new Map<string,string[]>();
    for (const material of materials) receiptIds.set(String(material.id), taskRows.map(task => {
      const hash = createHash("sha256").update(`${material.id}:${task.id}`).digest("hex");
      return `material:${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
    }));
    const registration = materials.length ? (await db.prepare("SELECT id,response_json FROM deseret_inbox WHERE project_id=? AND sender='native-material' AND state='complete' AND id IN (SELECT value FROM json_each(?))").bind(projectId,JSON.stringify([...receiptIds.values()].flat())).all<Row>()).results : [];
    const registered = new Map(registration.map(item => [String(item.id),String(JSON.parse(String(item.response_json)).id || "")]));
    const readableMaterials = registered.size ? await deps.nativeFiles(context,[...new Set(registered.values())].filter(Boolean)) : [];
    const readableIds = new Set(readableMaterials.map(file => file.id));
    function receipt(material: Row | undefined) {
      if (!material) return { state: "unavailable", nativeVersionId: undefined };
      const nativeVersionId = material.state === "ready" ? (receiptIds.get(String(material.id)) ?? [])
        .map(id => registered.get(id)).find(id => id && readableIds.has(id)) : undefined;
      return { state: String(material.state), nativeVersionId };
    }
    const snapshot = JSON.parse(String(row.snapshot_json)) as Row;
    const actions: DeseretWorkspace["actions"] = [];
    if (role === "lead" && state.stage !== "archived") {
      if (state.intake === "pending") actions.push("intake.accept");
      if (!state.packages.length) actions.push("intake.requestSupplement");
      if (state.materials !== "ready" || await db.prepare("SELECT id FROM deseret_material_tasks WHERE project_id=? AND source_revision=? AND state IN ('failed','waiting_config') LIMIT 1").bind(projectId, row.source_revision).first()) actions.push("materials.retry");
      if (state.intake === "accepted" && ["production", "final_production"].includes(state.stage) && state.materials === "ready") actions.push("package.publish");
      if (state.packages.some(pack => !pack.withdrawn) && !state.deliveryLocked && !["已交付", "已归档", "已终止"].includes(String(context.project.status))) actions.push("package.withdraw");
      if (state.stage === "revision") actions.push("revision.assign");
    }
    if (role === "lead") actions.push("outbox.retry");
    if (role === "producer" && state.intake === "accepted" && state.materials === "ready" && state.stage === "production" && taskRows.some(task => progressEditableStatuses.includes(String(task.status)))) actions.push("scene.save");
    const reviewFiles = role === "qc" ? await deps.nativeFiles(context, [
      ...state.scenes.map(scene => scene.fileVersionId),
      ...state.packages.flatMap(pack => [...pack.scenes.map(scene => scene.fileVersionId), ...pack.files.map(file => file.fileVersionId)]),
    ]) : [];
    const reviewFileTasks = new Map(reviewFiles.map(file => [file.id, file.languageTaskId]));
    const scoped = role === "lead" ? state : scopeDeseretReview(state, (taskId, fileVersionId) =>
      taskIds.has(taskId) && (role !== "qc" || reviewFileTasks.get(fileVersionId) === taskId));
    const guidance = new Map(materials.filter(item => item.package_id != null).map(item => [String(item.id), item]));
    const activePackages = new Set(scoped.packages.filter(pack => !pack.withdrawn).map(pack => pack.id));
    const feedback = scoped.feedback.map(note => !note.files?.length ? note : {
      ...note, files: note.files.map(file => {
        const id = materialId(projectId, String(row.source_revision), file, "deseret_to_aigc", note.packageId);
        return { ...file, ...receipt(activePackages.has(note.packageId) ? guidance.get(id) : undefined) };
      }),
    });
    const refreshed = await deps.projectContext(email, projectId, false);
    const latestTasks = role === "lead" ? [] : (await db.prepare(`SELECT id FROM language_projects WHERE project_id=? AND ${role === "producer" ? "editor_email" : "reviewer_email"}=? ORDER BY id`).bind(projectId, email).all<Row>()).results;
    if (refreshed.actor.access !== context.actor.access || (role !== "lead" && taskRows.some(task => !latestTasks.some(latest => latest.id === task.id)))) reject("Project access changed. Reload the project.", "DESERET_FORBIDDEN", 403);
    return {
      ...state, ...scoped, feedback,
      projectId, projectTitle: object(snapshot.project) && typeof snapshot.project.title === "string" ? snapshot.project.title : String(context.project.name), deseretProjectId: String(row.deseret_project_id), sourceRevision: String(row.source_revision), submissionVersion: Number(row.submission_version), role,
      brief: object(snapshot.brief) ? snapshot.brief : {}, materialManifest: materials.filter(item => item.package_id == null)
        .map(item => ({ ...JSON.parse(String(item.manifest_json)), ...receipt(item) })),
      tasks: taskRows.map(task => ({ id: String(task.id), videoId: String(task.video_id), language: String(task.language), languageCode: String(task.language_code), status: String(task.status), editorEmail: task.editor_email ? String(task.editor_email) : undefined, reviewerEmail: task.reviewer_email ? String(task.reviewer_email) : undefined })),
      fileCandidates: files.map(file => ({ id: file.id, version: file.version, name: file.name, languageTaskId: file.languageTaskId, size: file.size, mimeType: file.mimeType, sha256: file.sha256, qualityPassed: file.qualityPassed, finalSubmission: file.finalSubmission || previouslyPublishedFinal(state, file), storageReady: file.storageReady })), actions,
      transfers: role === "lead" ? (await db.prepare("SELECT id,direction,package_id,manifest_json,state,attempts,last_error FROM deseret_material_tasks WHERE project_id=? AND source_revision=? ORDER BY created_at,id").bind(projectId, row.source_revision).all<Row>()).results.map(item => ({ id: String(item.id), direction: String(item.direction), packageId: item.package_id ? String(item.package_id) : undefined, name: String(JSON.parse(String(item.manifest_json)).name), state: String(item.state), attempts: Number(item.attempts), lastError: item.last_error ? String(item.last_error) : undefined })) : [],
      outbox: role === "lead" ? (await db.prepare("SELECT id,event_type,state,attempts,last_error FROM deseret_outbox WHERE project_id=? ORDER BY created_at DESC LIMIT 50").bind(projectId).all<Row>()).results.map(item => ({ id: String(item.id), type: String(item.event_type), state: String(item.state), attempts: Number(item.attempts), lastError: item.last_error ? String(item.last_error) : undefined })) : [],
    };
  }

  async function command(email: string, projectId: string, input: unknown) {
    enabled();
    if (!object(input) || !text(input.requestId, 120) || !identity.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || !text(input.action, 80) || !object(input.payload)) reject("Invalid integration action.");
    const hash = integrationBodyHash(JSON.stringify([projectId, input.action, input.payload, input.expectedRevision]));
    const receiptId = `native:${input.requestId}`;
    const replay = await previousResponse(db, receiptId, email, hash);
    if (replay) return workspace(email, projectId);
    const context = await deps.projectContext(email, projectId, true);
    const current = await workspace(email, projectId);
    if (current.revision !== input.expectedRevision) reject("The project was updated. Refresh before continuing.", "DESERET_CONFLICT", 409);
    if (!current.actions.includes(input.action as DeseretWorkspace["actions"][number])) reject("This action is unavailable for the current role or stage.", "DESERET_FORBIDDEN", 403);
    const row = await db.prepare("SELECT * FROM deseret_project_links WHERE id=?").bind(projectId).first<Row>();
    if (!row) reject("Project is unavailable.", "DESERET_PROJECT_UNAVAILABLE", 404);
    const state = readDeseretState(row);
    const payload = input.action === "scene.save" && object(input.payload.scene) ? input.payload.scene : input.payload;
    const at = now();
    const extra: DatabaseStatement[] = [];
    const writeGuards: string[] = [];
    const writeValues: (string | number | null)[] = [];
    if (input.action === "intake.accept") {
      state.intake = "accepted";
      if (state.materials === "ready") state.stage = "production";
      extra.push(deseretOutboxStatement(db, projectId, String(row.deseret_project_id), String(row.source_revision), "project.accepted", { aigcProjectId: projectId, videoIds: JSON.parse(String(row.native_video_ids)), languageTaskIds: JSON.parse(String(row.native_task_ids)), intakeState: "accepted" }, at));
    } else if (input.action === "intake.requestSupplement") {
      if (!text(payload.note) || !payload.note.trim()) reject("Describe the required supplemental materials.");
      state.intake = "needsSupplement";
      state.stage = "intake";
      state.supplementNote = payload.note.trim();
      extra.push(db.prepare("UPDATE deseret_material_tasks SET state='paused',updated_at=? WHERE project_id=? AND direction='deseret_to_aigc' AND state<>'ready'").bind(at, projectId));
      extra.push(deseretOutboxStatement(db, projectId, String(row.deseret_project_id), String(row.source_revision), "intake.supplement_requested", { note: state.supplementNote, submissionVersion: Number(row.submission_version) }, at));
    } else if (input.action === "materials.retry") {
      extra.push(db.prepare("UPDATE deseret_material_tasks SET state='pending',last_error=NULL,next_attempt_at=?,updated_at=? WHERE project_id=? AND source_revision=? AND state IN ('failed','waiting_config')").bind(at, at, projectId, row.source_revision));
      if (state.materials !== "ready") state.materials = "waiting_transfer";
    } else if (input.action === "outbox.retry") {
      extra.push(db.prepare("UPDATE deseret_outbox SET state='pending',next_attempt_at=?,last_error=NULL,updated_at=? WHERE project_id=? AND state='failed'").bind(at, at, projectId));
    } else if (input.action === "revision.assign") {
      if (!state.revisionSceneIds.length) reject("No requested revision is awaiting assignment.");
      state.stage = state.packages.at(-1)?.phase === "final" ? "final_production" : "production";
    } else if (input.action === "scene.save") {
      if (!text(payload.id, 100) || !identity.test(payload.id) || !text(payload.script, 20000) || !String(payload.script).trim() || typeof payload.duration !== "number" || !Number.isFinite(payload.duration) || payload.duration <= 0 || payload.duration > 3600 || !Number.isSafeInteger(payload.order) || Number(payload.order) < 1 || !Array.isArray(payload.characterIds) || payload.characterIds.length > 100 || payload.characterIds.some(item => !text(item, 120)) || !text(payload.voiceId, 120)) reject("Check the scene details.");
      const approvedIds = new Set(approvedSceneCharacters(current.brief).map(character => character.id));
      const characterIds = payload.characterIds as string[];
      if (new Set(characterIds).size !== characterIds.length || characterIds.some(id => !approvedIds.has(id))) reject("Select characters from the approved brief.", "DESERET_SCENE_CHARACTER_INVALID", 422);
      const file = (await deps.nativeFiles(context, [String(payload.fileVersionId)])).find(item => item.id === payload.fileVersionId);
      if (!file || !file.mimeType.startsWith("video/") || !file.storageReady) reject("Choose a registered video version from the assigned native task.");
      const editableTask = await db.prepare("SELECT status FROM language_projects WHERE id=? AND project_id=? AND editor_email=?").bind(file.languageTaskId, projectId, email).first<{ status: string }>();
      if (!editableTask || !progressEditableStatuses.includes(editableTask.status)) reject("The production task is not open for scene updates.", "DESERET_PRODUCTION_BLOCKED", 409);
      const previous = state.scenes.find(item => item.id === payload.id);
      if (!previous && state.scenes.length >= 200) reject("A review package supports up to 200 scenes.", "DESERET_SCENE_LIMIT", 422);
      if (previous && previous.languageTaskId !== file.languageTaskId) reject("A scene must remain in its assigned language task.", "DESERET_FORBIDDEN", 403);
      if (state.scenes.some(item => item.id !== payload.id && item.order === payload.order)) reject("Choose a unique scene order.");
      const scene: DeseretScene = { id: payload.id, order: Number(payload.order), version: previous ? previous.version + 1 : 1, duration: payload.duration, script: payload.script, characterIds: payload.characterIds as string[], voiceId: payload.voiceId, fileVersionId: file.id, languageTaskId: file.languageTaskId };
      if (previous && JSON.stringify({ ...previous, version: 0 }) === JSON.stringify({ ...scene, version: 0 })) scene.version = previous.version;
      if (previous && state.revisionSceneIds.includes(scene.id) && scene.version !== previous.version && previous.fileVersionId === scene.fileVersionId) reject("Requested scene revisions require a newly registered video version.", "DESERET_NEW_VERSION_REQUIRED", 409);
      writeGuards.push("EXISTS(SELECT 1 FROM language_projects WHERE id=? AND project_id=? AND editor_email=? AND status IN (SELECT value FROM json_each(?)))");
      writeValues.push(file.languageTaskId, projectId, email, JSON.stringify(progressEditableStatuses));
      if (previous) state.scenes.splice(state.scenes.indexOf(previous), 1, scene);
      else state.scenes.push(scene);
      state.scenes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    } else if (input.action === "package.withdraw") {
      const pack = state.packages.find(item => item.id === payload.packageId && !item.withdrawn);
      if (!pack) reject("The publication is unavailable.");
      const packTasks = [...new Set(pack.files.map(file => file.languageTaskId))];
      if (await db.prepare("SELECT id FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('已交付','已归档','已终止') LIMIT 1").bind(projectId, JSON.stringify(packTasks)).first()) reject("The published production has already been delivered or closed.", "delivery_locked", 409);
      writeGuards.push("NOT EXISTS(SELECT 1 FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('已交付','已归档','已终止'))");
      writeValues.push(projectId, JSON.stringify(packTasks));
      const controlsProduction = state.packages.filter(item => !item.withdrawn).at(-1)?.id === pack.id;
      const controlledTaskIds = packTasks.filter(taskId => state.packages.filter(item => !item.withdrawn && item.files.some(file => file.languageTaskId === taskId)).at(-1)?.id === pack.id);
      pack.withdrawn = true;
      pack.filesReady = false;
      if (controlledTaskIds.length) extra.push(db.prepare("UPDATE language_projects SET paused_from_status=CASE WHEN status='已暂停' THEN '制作中' ELSE paused_from_status END,status=CASE WHEN status='已暂停' THEN '已暂停' ELSE '制作中' END,revision=revision+1,updated_at=? WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status NOT IN ('已交付','已归档','已终止')").bind(at, projectId, JSON.stringify(controlledTaskIds)));
      if (controlsProduction || (state.stage === "delivery" && controlledTaskIds.length > 0)) {
        const hasApprovedStoryboard = packTasks.length > 0 && packTasks.every(taskId => currentStoryboardApproved(state,taskId));
        state.stage = pack.phase === "final" && hasApprovedStoryboard ? "final_production" : "production";
        if (state.stage === "production" && pack.phase === "final") state.revisionSceneIds = [];
      }
      extra.push(db.prepare("UPDATE deseret_material_tasks SET state='cancelled',updated_at=? WHERE package_id=? AND state<>'ready'").bind(at, pack.id), deseretOutboxStatement(db, projectId, String(row.deseret_project_id), String(row.source_revision), "review.withdrawn", { packageId: pack.id, packageVersion: pack.version, publicationId: pack.publicationId }, at));
    } else if (input.action === "package.publish") {
      const phase = payload.phase;
      if (!["storyboard", "final"].includes(String(phase))) reject("Choose a review phase.");
      if ((phase === "final") !== (state.stage === "final_production")) reject("Publish the current production phase.", "DESERET_PHASE_CONFLICT", 409);
      let scenes = structuredClone(state.scenes);
      const candidates = await deps.nativeFiles(context, [...scenes.map(scene => scene.fileVersionId), ...(typeof payload.fileVersionId === "string" ? [payload.fileVersionId] : [])]);
      if (phase === "final") {
        const final = candidates.find(file => file.id === payload.fileVersionId);
        if (!final || !final.mimeType.startsWith("video/")) reject("Choose the registered final video version.");
        if (!currentStoryboardApproved(state, final.languageTaskId)) reject("Publisher approval of the current storyboard is required before final publication.", "DESERET_CURRENT_STORYBOARD_REQUIRED", 409);
        if (isStoryboardFileVersion(state, final.id) || (!final.finalSubmission && !previouslyPublishedFinal(state, final))) reject("Submit the assembled final for quality review before publication.", "DESERET_FINAL_VERSION_REQUIRED", 409);
        const previousFinal = state.packages.filter(pack => pack.phase === "final" && pack.files.some(file => file.languageTaskId === final.languageTaskId)).at(-1);
        if (state.revisionSceneIds.length && !previousFinal?.scenes.some(scene => state.revisionSceneIds.includes(scene.id))) reject("Publish the language task requested for final revision.", "DESERET_REVISION_TARGET_REQUIRED", 409);
        if (previousFinal && state.revisionSceneIds.some(id => previousFinal.scenes.some(scene => scene.id === id)) && previousFinal.files.some(file => file.fileVersionId === final.id)) reject("Final revisions require a newly registered video version.", "DESERET_NEW_VERSION_REQUIRED", 409);
        scenes = [{ id: `final-${final.languageTaskId}`, order: 1, version: 1 + state.packages.filter(pack => pack.phase === "final" && pack.files.some(file => file.languageTaskId === final.languageTaskId)).length, duration: Number(payload.duration), script: scenes.filter(scene => scene.languageTaskId === final.languageTaskId).map(scene => scene.script).join("\n\n"), characterIds: [...new Set(scenes.filter(scene => scene.languageTaskId === final.languageTaskId).flatMap(scene => scene.characterIds))], voiceId: "", fileVersionId: final.id, languageTaskId: final.languageTaskId }];
        if (!Number.isFinite(scenes[0].duration) || scenes[0].duration <= 0 || scenes[0].duration > 14400) reject("Provide the final video duration.");
      }
      if (phase === "storyboard" && state.revisionSceneIds.some(id => {
        const prior = state.packages.filter(pack => pack.phase === "storyboard" && pack.scenes.some(scene => scene.id === id)).at(-1)?.scenes.find(scene => scene.id === id);
        const currentScene = scenes.find(scene => scene.id === id);
        return !prior || !currentScene || prior.fileVersionId === currentScene.fileVersionId || prior.version === currentScene.version;
      })) reject("Every requested scene revision requires a newly registered video version.", "DESERET_NEW_VERSION_REQUIRED", 409);
      if (!scenes.length) reject("Register the production scenes before publication.");
      if (scenes.length > 200) reject("A review package supports up to 200 scenes.", "DESERET_SCENE_LIMIT", 422);
      const files = scenes.map(scene => candidates.find(file => file.id === scene.fileVersionId));
      if (files.some(file => !file || !file.qualityPassed || !file.storageReady)) reject("Every published file requires completed native internal quality approval.", "DESERET_QUALITY_REQUIRED", 409);
      const verified = [...new Map((files as IntegrationNativeFile[]).map(file => [file.id, file])).values()];
      const publishedTaskIds = [...new Set(verified.map(file => file.languageTaskId))];
      if (await db.prepare("SELECT id FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('已暂停','已交付','已归档','已终止') LIMIT 1").bind(projectId, JSON.stringify(publishedTaskIds)).first()) reject("The production task is not open for publication.", "DESERET_PRODUCTION_BLOCKED", 409);
      writeGuards.push("NOT EXISTS(SELECT 1 FROM language_projects WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('已暂停','已交付','已归档','已终止'))");
      writeValues.push(projectId, JSON.stringify(publishedTaskIds));
      await deps.verifyNativeFiles(verified);
      for (const file of verified) {
        writeGuards.push(`EXISTS(SELECT 1 FROM project_files pf JOIN aigc_file_versions version ON version.id=pf.id JOIN aigc_files logical ON logical.id=version.file_id JOIN aigc_storage_objects storage ON storage.id=version.storage_object_id WHERE pf.id=? AND pf.project_id=? AND pf.deleted_at IS NULL AND pf.status IN ('qc_approved','final','delivered') AND logical.deleted_at IS NULL AND version.checksum_sha256=? AND storage.object_key=? AND storage.etag=? AND EXISTS(SELECT 1 FROM quality_rounds q WHERE q.file_id=pf.id AND q.result='approved')${phase === "final" && !previouslyPublishedFinal(state, file) ? ` AND ${finalSubmissionEvidenceSql}` : ""})`);
        writeValues.push(file.id, projectId, file.sha256, file.objectKey, file.etag);
      }
      const version = 1 + state.packages.filter(pack => pack.phase === phase).length;
      const packageFiles: DeseretPublishedFile[] = verified.map(file => ({ id: file.id, fileVersionId: file.id, languageTaskId: file.languageTaskId, version: file.version, name: file.name, size: file.size, purpose: phase === "final" ? "final_video" : "storyboard_video", mimeType: file.mimeType, storageProfileId: file.storageProfileId, objectKey: file.objectKey, ...(/^[a-f0-9]{64}$/.test(file.sha256) ? { sha256: file.sha256 } : { integrity: { algorithm: "wasabi-sha256-parts-v1" as const, value: file.sha256.replace(/^wasabi-sha256-parts-v1:/, "") } }) }));
      const selectedIds = new Set(scenes.flatMap(scene => scene.characterIds));
      const characters = approvedSceneCharacters(current.brief).filter(character => selectedIds.has(character.id));
      if (characters.length !== selectedIds.size) reject("Update the scene characters before publishing.", "DESERET_SCENE_CHARACTER_INVALID", 422);
      const pack: DeseretReviewPackage = { characters, id: randomUUID(), phase: phase as "storyboard" | "final", version, publicationId: randomUUID(), publishedAt: at, scenes, files: packageFiles, filesReady: false };
      if (Buffer.byteLength(JSON.stringify({ scenes, files: packageFiles }), "utf8") > 850000) reject("The publication metadata exceeds the service request limit.", "DESERET_PACKAGE_TOO_LARGE", 413);
      state.packages.push(pack);
      state.stage = phase === "final" ? "final_review" : "storyboard_review";
      state.revisionSceneIds = [];
      extra.push(...materialStatements(db, projectId, String(row.source_revision), packageFiles, at, "aigc_to_deseret", pack.id));
    }
    state.revision += 1;
    await guardedMutation(db, `${context.access.sql} AND EXISTS (SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)${writeGuards.length ? ` AND ${writeGuards.join(" AND ")}` : ""}`, [...context.access.values, projectId, current.revision, ...writeValues], [
      db.prepare("UPDATE deseret_project_links SET state_json=?,revision=revision+1,updated_at=? WHERE id=?").bind(JSON.stringify(state), at, projectId), ...extra,
      responseStatement(db, receiptId, email, projectId, hash, { accepted: true }, at),
      prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('project.deseret_action',?,?,?,?)").bind(email, projectId, JSON.stringify({ action: input.action, requestId: input.requestId, sourceRevision: row.source_revision, revision: state.revision }), at),
    ]);
    return workspace(email, projectId);
  }
  return { handoff, receive, workspace, command };
}
