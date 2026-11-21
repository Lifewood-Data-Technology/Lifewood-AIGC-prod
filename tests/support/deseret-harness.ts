// Real Deseret integration service over an in-memory SQLite database with the production tables it touches.
// Synthetic data only: no MySQL, object storage, network or real accounts.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createDeseretIntegrationService, type IntegrationProjectContext } from "../../db/deseret-integration";
import { nativeIntegrationFiles } from "../../db/deseret-native-files";
import type { DeseretIntegrationState, DeseretReviewPackage, DeseretScene } from "../../lib/deseret-workspace";
import type { HandoffMaterial, IntegrationEnvelope } from "../../lib/deseret-integration-contract";
import { PublicError } from "../../lib/security-controls";
import { sqliteDatabase } from "./sqlite-database";
import type { DatabaseStatement } from "../../db/database";

export type Row = Record<string, unknown>;
export const PROJECT = "aigc-project-1";
export const OTHER_PROJECT = "aigc-project-2";
export const EXTERNAL = "db-project-1";
export const SOURCE = "src-1";
export const LEAD = "lead@example.test";
export const MAKER = "maker@example.test";
export const OTHER_MAKER = "other-maker@example.test";
export const QC = "qc@example.test";
export const OTHER_QC = "other-qc@example.test";
/** Assigned only in OTHER_PROJECT. */
export const FOREIGN_QC = "foreign-qc@example.test";
const NOW = Date.parse("2026-11-20T09:00:00.000Z");

const schema = `
CREATE TABLE mutation_guards (id TEXT PRIMARY KEY, satisfied INTEGER NOT NULL, CONSTRAINT mutation_guard_current CHECK (satisfied = 1));
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, status TEXT, due_date TEXT, deleted_at TEXT, client_id TEXT);
CREATE TABLE clients (id TEXT PRIMARY KEY, deleted_at TEXT, status TEXT NOT NULL DEFAULT 'Active');
CREATE TABLE business_deletion_locks (scope_id TEXT);
CREATE TABLE language_projects (id TEXT PRIMARY KEY, project_id TEXT, video_id TEXT, language TEXT, language_code TEXT, status TEXT,
  editor_email TEXT, reviewer_email TEXT, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
CREATE TABLE deseret_project_links (id TEXT PRIMARY KEY, deseret_project_id TEXT UNIQUE, source_revision TEXT, submission_version INTEGER,
  snapshot_json TEXT, state_json TEXT, native_video_ids TEXT, native_task_ids TEXT, revision INTEGER, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE deseret_inbox (id TEXT PRIMARY KEY, sender TEXT, project_id TEXT, payload_hash TEXT, state TEXT, response_json TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE deseret_material_tasks (id TEXT PRIMARY KEY, project_id TEXT, source_revision TEXT, file_id TEXT, file_version INTEGER, manifest_json TEXT,
  direction TEXT, package_id TEXT, target_json TEXT, state TEXT, attempts INTEGER, last_error TEXT, lease_id TEXT, lease_expires_at TEXT,
  next_attempt_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE deseret_outbox (id TEXT PRIMARY KEY, project_id TEXT, source_revision TEXT, event_type TEXT, body_json TEXT, state TEXT, attempts INTEGER,
  lease_id TEXT, lease_expires_at TEXT, next_attempt_at TEXT, last_error TEXT, created_at TEXT, updated_at TEXT, sequence INTEGER);
CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, action TEXT, actor_email TEXT, subject TEXT, details TEXT, created_at TEXT, request_id TEXT);
`;
// The native file tables the production read query (nativeIntegrationFiles) joins, with the columns it reads.
const nativeSchema = `
CREATE TABLE project_files (id TEXT PRIMARY KEY, project_id TEXT, language_project_id TEXT, directory TEXT, original_name TEXT, storage_name TEXT, object_key TEXT,
  mime_type TEXT, size_bytes INTEGER, version INTEGER, uploader_email TEXT, status TEXT, source TEXT DEFAULT 'project', created_at TEXT, deleted_at TEXT);
CREATE TABLE aigc_folders (id TEXT PRIMARY KEY, parent_folder_id TEXT, language_project_id TEXT, folder_code TEXT, deleted_at TEXT, node_type TEXT, path_cache TEXT);
CREATE TABLE aigc_files (id TEXT PRIMARY KEY, language_project_id TEXT, folder_id TEXT, status TEXT, deleted_at TEXT, source TEXT NOT NULL DEFAULT 'project', file_kind TEXT DEFAULT 'document', current_version_id TEXT);
CREATE TABLE aigc_storage_objects (id TEXT PRIMARY KEY, object_key TEXT, etag TEXT, bucket_name TEXT, endpoint_url TEXT, region_name TEXT);
CREATE TABLE aigc_file_versions (id TEXT PRIMARY KEY, file_id TEXT, version_number INTEGER, original_name TEXT, checksum_sha256 TEXT, size_bytes INTEGER, storage_object_id TEXT, created_at TEXT, created_by TEXT);
CREATE TABLE production_flow_events (id TEXT PRIMARY KEY, language_project_id TEXT); CREATE TABLE production_flow_files (event_id TEXT, file_version_id TEXT);
CREATE TABLE production_checkpoints (id TEXT PRIMARY KEY, language_project_id TEXT, editor_email TEXT, status TEXT, version_number INTEGER, completeness_status TEXT, updated_at TEXT);
CREATE TABLE production_checkpoint_files (checkpoint_id TEXT, file_version_id TEXT); CREATE TABLE production_final_submission_files (submission_id TEXT, file_version_id TEXT, category TEXT);
CREATE TABLE quality_rounds (id INTEGER PRIMARY KEY, file_id TEXT, result TEXT);
CREATE TABLE asset_collections (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE asset_collection_files (collection_id TEXT, file_id TEXT);
CREATE TABLE production_final_submissions (id TEXT PRIMARY KEY, final_version_id TEXT, language_project_id TEXT, submitted_by TEXT);
CREATE TABLE production_submission_receipts (id TEXT PRIMARY KEY, actor_email TEXT, response_json TEXT);
CREATE TABLE aigc_file_operations (id INTEGER PRIMARY KEY, file_id TEXT, folder_id TEXT, operation TEXT, actor_email TEXT, details TEXT, created_at TEXT);
CREATE TABLE handover_records (id TEXT PRIMARY KEY, language_project_id TEXT, checkpoint_id TEXT, from_user_email TEXT, to_user_email TEXT, status TEXT, created_at TEXT);
CREATE TABLE deseret_production_archives (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, language_project_id TEXT NOT NULL, archive_number INTEGER NOT NULL,
  created_by_email TEXT NOT NULL, next_steps TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (language_project_id, archive_number));
CREATE TABLE deseret_archive_files (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL, language_project_id TEXT NOT NULL, file_version_id TEXT NOT NULL, role TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (archive_id, file_version_id));
CREATE TABLE deseret_package_sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, package_id TEXT NOT NULL, scene_id TEXT NOT NULL, scene_version INTEGER NOT NULL,
  language_project_id TEXT NOT NULL, video_version_id TEXT NOT NULL, archive_id TEXT NOT NULL, confirmed_by_email TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (package_id, scene_id));
CREATE TABLE language_assignment_history (id TEXT, language_project_id TEXT, previous_editor_email TEXT, new_editor_email TEXT, created_at TEXT);
CREATE TABLE task_material_links (language_project_id TEXT, material_file_id TEXT, material_version_id TEXT);
CREATE TABLE material_standards (scope_type TEXT, project_id TEXT, language_project_id TEXT, status TEXT, is_current INTEGER, logical_file_id TEXT, file_version_id TEXT);
CREATE TABLE deseret_task_handovers (id TEXT PRIMARY KEY, handover_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, language_project_id TEXT NOT NULL, handover_kind TEXT NOT NULL,
  from_editor_email TEXT NOT NULL, to_editor_email TEXT NOT NULL, archive_id TEXT, verification TEXT NOT NULL, verification_notes TEXT NOT NULL,
  verified_by_email TEXT, verified_at TEXT, created_at TEXT NOT NULL);
`;
export type NativeRow = { id: string; taskId: string; directory: string; status: string; name: string; mimeType: string; size: number; sha256: string; qualityApproved?: boolean; projectId?: string; source?: string; createdBy?: string };

const video = (id: string, version: number, task = "task-1") => ({
  id, fileVersionId: id, languageTaskId: task, version, name: `book-trailer-${task}-v${version}.mp4`, size: 4096,
  purpose: "final_video", mimeType: "video/mp4", storageProfileId: "wasabi-main", objectKey: `projects/p1/${id}.mp4`, sha256: "a".repeat(64),
});
export const finalV1 = video("file-final-v1", 1);
export const otherTaskFinal = video("file-final-t2", 1, "task-2");
const storyboardScene: DeseretScene = { id: "scene-1", order: 1, version: 1, duration: 30, script: "Opening", characterIds: [], voiceId: "", fileVersionId: "file-scene-v1", languageTaskId: "task-1" };
const finalScene = (file = finalV1, id = "final-task-1", task = "task-1", order = 1): DeseretScene =>
  ({ id, order, version: 1, duration: 30, script: "Opening", characterIds: [], voiceId: "", fileVersionId: file.id, languageTaskId: task });
const storyboardPackage: DeseretReviewPackage = {
  id: "pkg-storyboard-1", phase: "storyboard", version: 1, publicationId: "pub-sb-1", publishedAt: "2026-11-10T00:00:00.000Z", filesReady: true, conclusion: "approved",
  scenes: [storyboardScene], files: [{ ...finalV1, id: "file-scene-v1", fileVersionId: "file-scene-v1", name: "scene-1.mp4", purpose: "storyboard_video" }],
};
/** One final publication reviewed as two scenes in two language tasks (task-1: MAKER/QC, task-2: OTHER_MAKER/OTHER_QC). */
export function finalReviewState(): DeseretIntegrationState {
  const joint: DeseretReviewPackage = {
    id: "pkg-final-1", phase: "final", version: 1, publicationId: "pub-final-1", publishedAt: "2026-11-18T00:00:00.000Z", filesReady: true,
    scenes: [finalScene(), finalScene(otherTaskFinal, "final-task-2", "task-2", 2)], files: [finalV1, otherTaskFinal],
  };
  return { stage: "final_review", intake: "accepted", revision: 7, materials: "ready", scenes: [storyboardScene],
    packages: [storyboardPackage, joint], feedback: [], authorFeedback: [], revisionSceneIds: [] };
}
export const bothScenesRevised = [{ sceneId: "final-task-1", sceneVersion: 1, decision: "revision" }, { sceneId: "final-task-2", sceneVersion: 1, decision: "revision" }];

// Reviewed finals live in the task's production folder and are readable to QC by their review status.
const nativeVideo = (file: typeof finalV1): NativeRow => ({ id: file.id, taskId: file.languageTaskId, directory: "03_项目制作", status: "final", name: file.name,
  mimeType: file.mimeType, size: file.size, sha256: file.sha256, qualityApproved: true });

export type Harness = ReturnType<typeof createHarness>;
export function createHarness(initial: DeseretIntegrationState = finalReviewState()) {
  const db = sqliteDatabase();
  let failingSummary = false;
  db.sqlite.exec(schema);
  db.sqlite.exec(nativeSchema);
  db.sqlite.exec("INSERT INTO clients (id, deleted_at) VALUES ('client-1', NULL)");
  const folder = db.sqlite.prepare("INSERT INTO aigc_folders (id,parent_folder_id,language_project_id,folder_code,deleted_at) VALUES (?,?,?,?,NULL)");
  for (const taskId of ["task-1", "task-2", "task-x"]) {
    folder.run(`folder-${taskId}`, null, taskId, "root");
    for (const code of ["01", "02", "03", "04"]) folder.run(`folder-${taskId}-${code}`, `folder-${taskId}`, taskId, code);
  }
  /** Register one native file version exactly as the production upload path records it. */
  function addNative(file: NativeRow) {
    const folderId = `folder-${file.taskId}-${file.directory.slice(0, 2)}`;
    db.sqlite.prepare("INSERT INTO project_files (id,project_id,language_project_id,directory,original_name,storage_name,object_key,mime_type,size_bytes,version,uploader_email,status,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)")
      .run(file.id, file.projectId ?? PROJECT, file.taskId, file.directory, file.name, file.name, `native/${file.id}`, file.mimeType, file.size, "service:deseret", file.status, file.source ?? "project", "2026-11-19T00:00:00.000Z");
    db.sqlite.prepare("INSERT INTO aigc_files (id,language_project_id,folder_id,status,deleted_at) VALUES (?,?,?,?,NULL)").run(`logical-${file.id}`, file.taskId, folderId, file.status);
    db.sqlite.prepare("INSERT INTO aigc_storage_objects VALUES (?,?,?,?,?,?)").run(`object-${file.id}`, `native/${file.id}`, "etag", "", "", "");
    db.sqlite.prepare("INSERT INTO aigc_file_versions (id,file_id,version_number,original_name,checksum_sha256,size_bytes,storage_object_id,created_at,created_by) VALUES (?,?,1,?,?,?,?,?,?)").run(file.id, `logical-${file.id}`, file.name, file.sha256, file.size, `object-${file.id}`, "2026-11-19T00:00:00.000Z", file.createdBy ?? null);
    if (file.qualityApproved) db.sqlite.prepare("INSERT INTO quality_rounds (file_id,result) VALUES (?,'approved')").run(file.id);
  }
  for (const file of [finalV1, otherTaskFinal]) addNative(nativeVideo(file));
  db.sqlite.prepare("INSERT INTO projects (id,name,status,due_date,client_id) VALUES (?,?,?,?,'client-1')").run(PROJECT, "Book trailer", "制作中", "2026-12-01");
  db.sqlite.prepare("INSERT INTO projects (id,name,status,due_date,client_id) VALUES (?,?,?,?,'client-1')").run(OTHER_PROJECT, "Other book", "制作中", "2026-12-01");
  const task = db.sqlite.prepare("INSERT INTO language_projects (id,project_id,video_id,language,language_code,status,editor_email,reviewer_email) VALUES (?,?,?,?,?,?,?,?)");
  task.run("task-1", PROJECT, "video-1", "English", "en", "待客户预览", MAKER, QC);
  task.run("task-2", PROJECT, "video-2", "English", "en", "待客户预览", OTHER_MAKER, OTHER_QC);
  task.run("task-x", OTHER_PROJECT, "video-x", "English", "en", "制作中", "x-maker@example.test", FOREIGN_QC);
  db.sqlite.prepare("INSERT INTO deseret_project_links VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(PROJECT, EXTERNAL, SOURCE, 1,
    JSON.stringify({ project: { title: "Book trailer" }, brief: {} }), JSON.stringify(initial), JSON.stringify(["video-1", "video-2"]),
    // Production keeps the link revision column and state.revision in step.
    JSON.stringify(["task-1", "task-2"]), initial.revision, LEAD, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");

  function context(access: string, email: string, projectId = PROJECT): IntegrationProjectContext {
    const project = db.sqlite.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Row;
    return { db, actor: { email, access }, project, access: { sql: "EXISTS(SELECT 1 FROM projects WHERE id=?)", values: [projectId] } };
  }
  const nativeCalls: { email: string; ids?: string[]; incomingMaterials: boolean }[] = [];
  const service = createDeseretIntegrationService({
    db,
    config: { enabled: true, peerBaseUrl: "https://deseret.example.test/", allowLoopbackHttp: false, incomingKeyId: "in", incomingSecret: "unused",
      outgoingKeyId: "out", outgoingSecret: "unused", clientId: "client", intakeOwnerEmail: LEAD, intakeDueDays: 14 },
    clock: () => NOW,
    createNativeProject: async () => { throw new Error("not used"); },
    verifyNativeFiles: async () => {},
    serviceProjectContext: async () => context("project", "service:deseret"),
    // Mirrors the production project access rule: the lead, or an account assigned to a task of this project.
    async projectContext(email, projectId) {
      if (email === LEAD) return context("project", email, projectId);
      const assigned = db.sqlite.prepare("SELECT editor_email FROM language_projects WHERE project_id=? AND (editor_email=? OR reviewer_email=?)").get(projectId, email, email) as Row | undefined;
      if (!assigned) throw new PublicError("Forbidden", 403, "FORBIDDEN");
      return context(assigned.editor_email === email ? "production" : "quality", email, projectId);
    },
    // The production read query itself, over the native tables above.
    nativeFiles: async (ctx, ids, options) => {
      nativeCalls.push({ email: ctx.actor.email, ...(ids ? { ids: [...ids] } : {}), incomingMaterials: Boolean(options?.incomingMaterials) });
      return nativeIntegrationFiles(ctx, ids, options);
    },
    projectSummaryStatement: () => db.prepare(failingSummary ? "INSERT INTO missing_summary_table VALUES (1)" : "UPDATE projects SET name=name WHERE 0"),
  });

  function state(): DeseretIntegrationState {
    return JSON.parse(String((db.sqlite.prepare("SELECT state_json FROM deseret_project_links WHERE id=?").get(PROJECT) as Row).state_json));
  }
  function snapshot() {
    return {
      link: db.sqlite.prepare("SELECT state_json, revision FROM deseret_project_links").all(),
      tasks: db.sqlite.prepare("SELECT id, status, revision FROM language_projects ORDER BY id").all(),
      inbox: db.sqlite.prepare("SELECT * FROM deseret_inbox ORDER BY id").all(),
      audit: db.sqlite.prepare("SELECT * FROM audit_logs ORDER BY id").all(),
      materials: db.sqlite.prepare("SELECT * FROM deseret_material_tasks ORDER BY id").all(),
    };
  }
  async function rejectsUnchanged(run: () => Promise<unknown>, code: string, status?: number) {
    const before = snapshot();
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof PublicError, String(error));
      assert.equal(error.code, code, error.message);
      if (status !== undefined) assert.equal(error.status, status);
      return true;
    });
    assert.deepEqual(snapshot(), before);
  }
  const materialTaskId = (file: Pick<HandoffMaterial, "id" | "version">, packageId: string | null) =>
    createHash("sha256").update(JSON.stringify([PROJECT, SOURCE, "deseret_to_aigc", packageId ?? "", file.id, file.version])).digest("hex");
  const receiptId = (materialTask: string, taskId: string) => {
    const hash = createHash("sha256").update(`${materialTask}:${taskId}`).digest("hex");
    return `material:${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  };
  /**
   * The transfer worker finished one material and registered it natively in one task, as `registerIncoming`
   * does: an `available` version in the task's `02_客户素材` folder plus its per-task receipt.
   */
  function transferReady(file: HandoffMaterial, packageId: string | null, taskId: string, nativeId: string, placement: { directory?: string; status?: string } = {}) {
    const id = materialTaskId(file, packageId);
    assert.equal(db.sqlite.prepare("UPDATE deseret_material_tasks SET state='ready' WHERE id=?").run(id).changes, 1);
    db.sqlite.prepare("INSERT INTO deseret_inbox VALUES (?,?,?,?,?,?,?,?)").run(receiptId(id, taskId), "native-material", PROJECT, "h", "complete", JSON.stringify({ id: nativeId }), "t", "t");
    if (!db.sqlite.prepare("SELECT 1 FROM project_files WHERE id=?").get(nativeId))
      addNative({ id: nativeId, taskId, directory: placement.directory ?? "02_客户素材", status: placement.status ?? "available", name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256! });
  }
  /** A handoff material (no package) as intake records it: one pending deseret_to_aigc transfer task. */
  function addHandoffMaterial(file: HandoffMaterial) {
    db.sqlite.prepare("INSERT INTO deseret_material_tasks (id,project_id,source_revision,file_id,file_version,manifest_json,direction,package_id,target_json,state,attempts,last_error,lease_id,lease_expires_at,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'deseret_to_aigc',NULL,NULL,'pending',0,NULL,NULL,NULL,?,?,?)")
      .run(materialTaskId(file, null), PROJECT, SOURCE, file.id, file.version, JSON.stringify(file), "t", "t", "t");
  }
  /**
   * Deterministic interleaving gate. The first statement whose SQL starts with `prefix` runs its read, then
   * resolves `arrived` and waits for `release()` before returning that (by then possibly stale) result. Later
   * statements, including the competing delivery's, are not held.
   */
  function holdFirst(prefix: string) {
    const prepare = db.prepare;
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const held = (statement: DatabaseStatement): DatabaseStatement => ({
      ...statement,
      bind: (...values: unknown[]) => held(statement.bind(...values)),
      async first<T>(column?: string) { const row = await statement.first<T>(column); arrive(); await released; return row; },
      async all<T>() { const rows = await statement.all<T>(); arrive(); await released; return rows; },
    });
    db.prepare = (sql: string) => {
      if (!sql.startsWith(prefix)) return prepare(sql);
      db.prepare = prepare;
      return held(prepare(sql));
    };
    return { arrived, release: () => release() };
  }
  return { db, service, state, snapshot, rejectsUnchanged, materialTaskId, transferReady, addHandoffMaterial, addNative, nativeCalls, context, holdFirst, failSummary: (value = true) => { failingSummary = value; } };
}

export function concludedEnvelope(qaRevision: unknown, eventId = "evt-final-revision", payload: Row = {}) {
  const envelope = {
    schemaVersion: 1, eventId, type: "review.concluded", projectId: EXTERNAL, sourceRevision: SOURCE, occurredAt: "2026-11-20T08:00:00.000Z",
    payload: { packageId: "pkg-final-1", packageVersion: 1, conclusion: "revision", decisions: bothScenesRevised, ...(qaRevision === undefined ? {} : { qaRevision }), ...payload },
  } as IntegrationEnvelope;
  return [envelope, JSON.stringify(envelope)] as const;
}
export function feedbackEnvelope(eventId: string, files: HandoffMaterial[], payload: Row = {}) {
  const envelope = { schemaVersion: 1, eventId, type: "review.feedback", projectId: EXTERNAL, sourceRevision: SOURCE, occurredAt: "2026-11-20T07:00:00.000Z",
    payload: { packageId: "pkg-final-1", packageVersion: 1, actorId: "mkt-3", body: "See the attached reference.", files, ...payload } } as IntegrationEnvelope;
  return [envelope, JSON.stringify(envelope)] as const;
}

/** A canonical Deseret guidance manifest, as the Deseret guidance upload endpoint registers it. */
export function guidanceImage(n: number, override: Row = {}): HandoffMaterial & Row {
  return { id: `guide-${n}`, version: 1, size: 2048 + n, sha256: n.toString(16).padStart(64, "0"), purpose: "guidance", storageProfileId: "deseret-main",
    objectKey: `aigc-guidance/${EXTERNAL}/guide-${n}.png`, name: `frame-${n}.png`, mimeType: "image/png", ...override } as HandoffMaterial & Row;
}
