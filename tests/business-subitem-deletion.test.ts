// Permanent deletion of one video or one language version, reusing the project permanent-deletion model:
// server-side authority, impact preview with a plan hash, exact-name confirmation, idempotent submission, scope
// locks against concurrent work, exclusive content removed and shared content (siblings, the parent project,
// other projects, shared stored objects) kept. Synthetic data on the full schema contract only.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBusinessAvailable, businessScopes, createBusinessDeletionService, type DeletionTarget } from "../db/business-deletion";
import { PublicError } from "../lib/security-controls";
import { contractDatabase } from "./support/contract-database";

const LEAD = "lead@example.test";
const NOW = Date.parse("2026-11-21T08:00:00.000Z");
type Db = ReturnType<typeof contractDatabase>;
let db: Db;
let purged: string[];
let service: ReturnType<typeof createBusinessDeletionService>;

/** A file version of a language task. Versions sharing bytes share one stored object (object keys are unique). */
function addFile(id: string, projectId: string, taskId: string, folderId: string, objectKey: string, status = "available") {
  const store = db.sqlite.prepare("SELECT id FROM aigc_storage_objects WHERE object_key=?").get(objectKey) as { id: string } | undefined;
  if (!store) db.insert("aigc_storage_objects", { id: `obj-${id}`, provider: "wasabi", bucket_name: "bucket", region_name: "r", endpoint_url: "https://e", object_key: objectKey, created_at: "t" });
  db.insert("aigc_files", { id: `lf-${id}`, language_project_id: taskId, folder_id: folderId, display_name: `${id}.bin`, file_kind: "other", current_version_id: id, status, source: "project", created_by: LEAD, created_at: "t", updated_at: "t" });
  db.insert("aigc_file_versions", { id, file_id: `lf-${id}`, version_number: 1, original_name: `${id}.bin`, db_file_name: `${id}.bin`, storage_object_id: store?.id ?? `obj-${id}`, mime_type: "application/octet-stream", size_bytes: 10, created_by: LEAD, created_at: "t" });
  db.insert("project_files", { id, project_id: projectId, language_project_id: taskId, directory: "03_项目制作", original_name: `${id}.bin`, storage_name: `${id}.bin`, object_key: objectKey, mime_type: "application/octet-stream", size_bytes: 10, version: 1, uploader_email: LEAD, status, source: "project", created_at: "t" });
}
function folder(id: string, values: Record<string, unknown>) {
  db.insert("aigc_folders", { id, folder_code: id, name: id, path_cache: `/${id}`, depth: 1, node_type: "folder", is_system: 1, sort_order: 0, created_at: "t", updated_at: "t", ...values });
}
function task(id: string, projectId: string, videoId: string, language: string, status = "制作中") {
  db.insert("language_projects", { id, project_id: projectId, video_id: videoId, language, language_code: language.slice(0, 2).toLowerCase(), status, revision: 3, updated_at: "t", production_progress: 0 });
  folder(`ft-${id}`, { language_project_id: id, project_id: projectId, video_id: videoId, parent_folder_id: `fv-${videoId}` });
  folder(`ft-${id}-project`, { language_project_id: id, project_id: projectId, parent_folder_id: `ft-${id}`, folder_code: "03.project" });
}
/**
 * Project p1 (lead-owned): video v1 with English and Spanish, video v2 with French and German. Project p2 of the
 * same customer has a file sharing French's stored object. English and Spanish share one stored object.
 */
function business() {
  db = contractDatabase();
  db.insert("clients", { id: "c1", name: "Client", owner_email: LEAD, status: "Active", updated_at: "t" });
  for (const [project, name] of [["p1", "Book trailer"], ["p2", "Other book"]]) {
    folder(`fp-${project}`, { project_id: project, client_id: "c1" });
    db.insert("projects", { id: project, client_id: "c1", name, name_zh: name, name_en: name, sales_email: "sales@example.test", status: "制作中", specification: "{}", due_date: "2026-12-31", project_owner_email: LEAD, root_folder_id: `fp-${project}`, revision: 5, updated_at: "t" });
  }
  for (const [video, project, name] of [["v1", "p1", "Video A"], ["v2", "p1", "Video B"], ["v3", "p2", "Video C"]]) {
    folder(`fv-${video}`, { video_id: video, project_id: project, parent_folder_id: `fp-${project}` });
    db.insert("project_videos", { id: video, project_id: project, video_code: video, root_folder_id: `fv-${video}`, name, sort_order: 1, revision: 2, updated_at: "t" });
  }
  task("t-en", "p1", "v1", "English"); task("t-es", "p1", "v1", "Spanish"); task("t-fr", "p1", "v2", "French"); task("t-de", "p1", "v2", "German"); task("t-x", "p2", "v3", "English");
  addFile("en-eng", "p1", "t-en", "ft-t-en-project", "k/en-eng");
  addFile("en-shared", "p1", "t-en", "ft-t-en-project", "k/shared");
  addFile("es-copy", "p1", "t-es", "ft-t-es-project", "k/shared");
  addFile("fr-eng", "p1", "t-fr", "ft-t-fr-project", "k/cross");
  addFile("x-copy", "p2", "t-x", "ft-t-x-project", "k/cross");
  addFile("v1-brief", "p1", "t-es", "ft-t-es", "k/v1-brief");
  db.insert("production_checkpoints", { id: "cp-en", language_project_id: "t-en", version_number: 1, checkpoint_number: 1, revision_number: 1, editor_email: LEAD, status: "ready", completeness_status: "complete", completeness_json: "{}", project_file_version_id: "en-eng", preview_file_version_id: "", created_at: "t", updated_at: "t" });
  db.insert("production_checkpoint_files", { id: "cpf-en", checkpoint_id: "cp-en", file_version_id: "en-eng", file_role: "project", is_required: 0, created_at: "t" });
  db.insert("quality_rounds", { id: "qr-en", project_id: "p1", language_project_id: "t-en", file_id: "en-eng", round_number: 1, reviewer_email: "qc@example.test", result: "rejected", created_at: "t" });
  purged = [];
  service = createBusinessDeletionService({
    db, now: () => NOW,
    storage: { async assertReady() {}, async purge(key: string) { purged.push(key); } },
    async authority(email: string) { return { actor: { email, accountId: "acc-lead", revision: 1, access: "project" }, condition: "1=1", values: [] }; },
  });
}
const submission = (n: number) => `sub-0000-0000-0000-${String(n).padStart(4, "0")}`;
/** Reviews, confirms the exact name, ticks every shared link this target unlinks, and runs the deletion. */
async function remove(target: DeletionTarget, n = 1) {
  const preview = await service.preview(LEAD, target);
  await service.start(LEAD, { ...target, submissionId: submission(n), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name,
    unlinkShared: [] });
  return { preview, status: await service.resume(LEAD, submission(n)) };
}
const blocked = async (target: DeletionTarget, code: string) => assert.rejects(() => service.preview(LEAD, target), (error: unknown) => {
  assert.ok(error instanceof PublicError, String(error));
  assert.equal(error.code, code, error.message);
  return true;
});
const exists = (table: string, id: string) => db.count(table, "id=?", id) === 1;

describe("project permanent deletion (characterization, unchanged)", () => {
  beforeEach(business);
  it("removes the whole project and keeps the other project and the shared stored object", async () => {
    const { status } = await remove({ kind: "project", id: "p1" });
    assert.equal(status.state, "complete");
    assert.deepEqual(["t-en", "t-es", "t-fr", "t-de"].map(id => exists("language_projects", id)), [false, false, false, false]);
    assert.ok(exists("projects", "p1") === false && exists("projects", "p2") && exists("language_projects", "t-x") && exists("project_files", "x-copy"));
    assert.deepEqual(purged.sort(), ["k/en-eng", "k/shared", "k/v1-brief"], "k/cross is still used by p2");
  });
  it("still refuses a delivered project", async () => {
    db.sqlite.prepare("UPDATE language_projects SET status='已交付' WHERE id='t-fr'").run();
    await blocked({ kind: "project", id: "p1" }, "PROJECT_HISTORY_PROTECTED");
  });
});

describe("one language version", () => {
  beforeEach(business);
  const english: DeletionTarget = { kind: "language", id: "t-en" };

  it("previews only that language, named by video and language, and keeps the object it shares with Spanish", async () => {
    const preview = await service.preview(LEAD, english);
    assert.equal(preview.name, "Video A · English");
    assert.equal(preview.revision, 3);
    assert.deepEqual([preview.summary.projects, preview.summary.tasks, preview.summary.files, preview.summary.objects, preview.summary.retainedObjects], [0, 1, 2, 1, 1]);
    assert.deepEqual(preview.disclosure.retained.items.map(item => item.name), ["en-shared.bin"]);
  });

  it("removes the language and its exclusive content; siblings, the video, the project and shared objects stay", async () => {
    const { status } = await remove(english);
    assert.equal(status.state, "complete");
    assert.equal(exists("language_projects", "t-en"), false);
    for (const [table, id] of [["project_files", "en-eng"], ["project_files", "en-shared"], ["aigc_folders", "ft-t-en"], ["production_checkpoints", "cp-en"], ["quality_rounds", "qr-en"]]) assert.equal(exists(table, id), false, `${table}.${id}`);
    for (const [table, id] of [["language_projects", "t-es"], ["language_projects", "t-fr"], ["project_videos", "v1"], ["projects", "p1"], ["project_files", "es-copy"], ["project_files", "v1-brief"], ["aigc_folders", "fv-v1"], ["aigc_storage_objects", "obj-en-shared"]])
      assert.ok(exists(table, id), `${table}.${id} is kept`);
    assert.equal((db.sqlite.prepare("SELECT deleted_at FROM projects WHERE id='p1'").get() as { deleted_at: string | null }).deleted_at, null, "the parent project is not deleted");
    assert.deepEqual(purged, ["k/en-eng"]);
  });

  it("is idempotent per submission and refuses a different confirmation, a stale preview or a changed impact", async () => {
    const preview = await service.preview(LEAD, english);
    const request = { ...english, submissionId: submission(7), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name };
    await assert.rejects(() => service.start(LEAD, { ...request, confirmationName: "English" }), /changed|Review/);
    addFile("en-late", "p1", "t-en", "ft-t-en-project", "k/en-late");
    await assert.rejects(() => service.start(LEAD, request), (error: unknown) => (error as PublicError).code === "STALE_DELETION_PREVIEW");
    const fresh = await service.preview(LEAD, english);
    const again = { ...request, previewHash: fresh.previewHash };
    const first = await service.start(LEAD, again);
    assert.deepEqual(await service.start(LEAD, again), first, "the same submission returns the same job");
    await assert.rejects(() => service.start(LEAD, { ...again, revision: 99 }), (error: unknown) => (error as PublicError).code === "SUBMISSION_MISMATCH");
  });

  it("locks only that language while its deletion runs: siblings and the project stay writable, a project deletion waits", async () => {
    const preview = await service.preview(LEAD, english);
    await service.start(LEAD, { ...english, submissionId: submission(3), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name });
    const englishScopes = await businessScopes(db, { taskId: "t-en" });
    assert.ok(englishScopes.includes("language:t-en") && englishScopes.includes("video:v1"));
    await assert.rejects(() => assertBusinessAvailable(db, englishScopes), (error: unknown) => (error as PublicError).code === "BUSINESS_DELETED");
    await assertBusinessAvailable(db, await businessScopes(db, { taskId: "t-es" }));
    await assertBusinessAvailable(db, await businessScopes(db, { projectId: "p1" }));
    const project = await service.preview(LEAD, { kind: "project", id: "p1" }).catch(error => error);
    if (!(project instanceof Error)) await assert.rejects(() => service.start(LEAD, { kind: "project", id: "p1", submissionId: submission(4), revision: project.revision, previewHash: project.previewHash, confirmationName: project.name }));
    await service.resume(LEAD, submission(3));
    await assert.rejects(() => service.preview(LEAD, english), (error: unknown) => (error as PublicError).code === "BUSINESS_DELETED");
  });

  it("protects delivered or archived history, Deseret projects, active uploads and files another scope still uses", async () => {
    db.sqlite.prepare("UPDATE language_projects SET status='已交付' WHERE id='t-en'").run();
    await blocked(english, "PROJECT_HISTORY_PROTECTED");
    business();
    db.sqlite.prepare("UPDATE projects SET status='已归档' WHERE id='p1'").run();
    await blocked(english, "PROJECT_HISTORY_PROTECTED");
    business();
    db.insert("deseret_project_links", { id: "p1", deseret_project_id: "db-1", source_revision: "s", submission_version: 1, snapshot_json: "{}", state_json: "{}", native_video_ids: "[]", native_task_ids: "[\"t-en\"]", revision: 1, created_by: LEAD, created_at: "t", updated_at: "t" });
    await blocked(english, "DESERET_SUBITEM_PROTECTED");
    business();
    db.insert("direct_upload_sessions", { id: "00000000-0000-4000-8000-000000000001", registration_id: "r", actor_email: LEAD, request_hash: "h", payload_json: JSON.stringify({ endpoint: "/api/production-workspace", fields: { task: "t-en", purpose: "materials" }, file: { name: "a.bin" } }), assets_json: "[]", authority_json: "{}", state: "uploading", scopes_json: "[\"project:p1\"]", expires_at: "2099-01-01T00:00:00.000Z", created_at: "t", updated_at: "2026-11-21T07:59:00.000Z" });
    await blocked(english, "BUSINESS_OPERATION_IN_PROGRESS");
    business();
    db.insert("asset_collections", { id: "col", collection_code: "col", title: "Collection", root_folder_id: "fp-p1", final_folder_id: "fp-p1", source_folder_id: "fp-p1", status: "active", final_file_id: "lf-en-eng", created_by: LEAD, created_at: "t", updated_at: "t" });
    await blocked(english, "SHARED_FILE_UNASSIGNABLE");
  });

  it("keeps a file another language still uses and moves it to that language, instead of refusing the whole plan", async () => {
    db.insert("production_checkpoints", { id: "cp-es", language_project_id: "t-es", version_number: 1, checkpoint_number: 1, revision_number: 1, editor_email: LEAD, status: "ready", completeness_status: "complete", completeness_json: "{}", project_file_version_id: "es-copy", preview_file_version_id: "", created_at: "t", updated_at: "t" });
    db.insert("task_material_links", { id: "tml", language_project_id: "t-es", checkpoint_id: "cp-es", material_file_id: "lf-en-eng", material_version_id: "en-eng", source_type: "task", created_by: LEAD, created_at: "t" });
    const preview = await service.preview(LEAD, english);
    const kept = preview.disclosure.shared.items.find(item => item.name === "en-eng.bin")!;
    assert.deepEqual([kept.kind, kept.owner, kept.ownerName, kept.optional], ["kept", "language", "Spanish", false]);
    assert.equal(preview.summary.objects, 0, "nothing shared is destroyed: en-eng moves, k/shared is Spanish's too");
    await remove(english, 9);
    const moved = db.sqlite.prepare("SELECT f.language_project_id, folder.language_project_id AS folder_task, pf.language_project_id AS file_task FROM aigc_files f JOIN aigc_folders folder ON folder.id=f.folder_id JOIN project_files pf ON pf.id=f.current_version_id WHERE f.id='lf-en-eng'").get();
    assert.deepEqual({ ...moved as object }, { language_project_id: "t-es", folder_task: "t-es", file_task: "t-es" });
    assert.ok(exists("task_material_links", "tml") && exists("aigc_file_versions", "en-eng") && !exists("language_projects", "t-en"));
    assert.deepEqual(purged, []);
    // English's own report linked that file; left unticked, the link is kept as history next to the move.
    assert.deepEqual(history("lf-en-eng"), [["business.deleted_scope_reference_retained", "Video A · English"], ["business.moved_from_deleted_scope", "Video A · English"]]);
  });

  /** English's report links Spanish's file and Spanish's brief: originals owned by another language. */
  const linkOriginals = () => {
    db.insert("production_checkpoint_files", { id: "cpf-en-es", checkpoint_id: "cp-en", file_version_id: "es-copy", file_role: "video", is_required: 0, created_at: "t" });
    db.insert("production_checkpoint_files", { id: "cpf-en-brief", checkpoint_id: "cp-en", file_version_id: "v1-brief", file_role: "other", is_required: 0, created_at: "t" });
  };
  const history = (file: string) => (db.sqlite.prepare("SELECT operation, details FROM aigc_file_operations WHERE file_id=? ORDER BY id").all(file) as { operation: string; details: string }[])
    .map(row => [row.operation, (JSON.parse(row.details) as { target: { kind: string; name: string } }).target.name]);
  for (const [label, choose, records] of [["none", 0, 2], ["some", 1, 1], ["all", 2, 0]] as const) {
    it(`accepts ${label} of the optional links ticked: ticked links are cleaned, unticked ones become history on the original`, async () => {
      linkOriginals();
      const preview = await service.preview(LEAD, english);
      const links = preview.disclosure.shared.items.filter(item => item.optional).sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(links.map(item => [item.kind, item.name, item.ownerName]), [["link", "es-copy.bin", "Spanish"], ["link", "v1-brief.bin", "Spanish"]]);
      await service.start(LEAD, { ...english, submissionId: submission(30 + choose), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: links.slice(0, choose).map(item => item.id) });
      await service.resume(LEAD, submission(30 + choose));
      // The originals and every other reference stay whatever was ticked; only English's own link rows are gone.
      assert.deepEqual([exists("production_checkpoint_files", "cpf-en-es"), exists("project_files", "es-copy"), exists("project_files", "v1-brief"), exists("aigc_file_versions", "v1-brief")], [false, true, true, true]);
      assert.equal(history("lf-es-copy").length + history("lf-v1-brief").length, records);
      if (records) assert.deepEqual(history("lf-v1-brief"), [["business.deleted_scope_reference_retained", "Video A · English"]]);
      assert.deepEqual(purged, ["k/en-eng"]);
    });
  }

  it("refuses a selection that is not one of this target's optional links", async () => {
    linkOriginals();
    const preview = await service.preview(LEAD, english);
    await assert.rejects(() => service.start(LEAD, { ...english, submissionId: submission(39), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: ["kept:lf-en-eng"] }),
      (error: unknown) => (error as PublicError).code === "INVALID_SHARED_SELECTION");
  });

  it("deletes the last language of a video without deleting the video upward", async () => {
    await remove({ kind: "language", id: "t-es" }, 2);
    await remove(english, 3);
    assert.ok(exists("project_videos", "v1") && exists("projects", "p1") && exists("aigc_folders", "fv-v1"), "the empty video and its folder stay");
    assert.equal(db.count("language_projects", "video_id='v1'"), 0);
  });
});

describe("one video", () => {
  beforeEach(business);
  const videoA: DeletionTarget = { kind: "video", id: "v1" };

  it("removes the video with all its languages and video-level files; the other video, the project and other projects stay", async () => {
    const preview = await service.preview(LEAD, videoA);
    assert.equal(preview.name, "Video A");
    assert.deepEqual([preview.summary.projects, preview.summary.tasks], [0, 2]);
    const { status } = await remove(videoA);
    assert.equal(status.state, "complete");
    for (const [table, id] of [["project_videos", "v1"], ["language_projects", "t-en"], ["language_projects", "t-es"], ["project_files", "v1-brief"], ["aigc_folders", "fv-v1"]]) assert.equal(exists(table, id), false, `${table}.${id}`);
    for (const [table, id] of [["project_videos", "v2"], ["language_projects", "t-fr"], ["projects", "p1"], ["aigc_folders", "fp-p1"], ["project_files", "fr-eng"]]) assert.ok(exists(table, id), `${table}.${id} is kept`);
    assert.deepEqual(purged.sort(), ["k/en-eng", "k/shared", "k/v1-brief"], "the object shared only inside the video goes with it");
  });

  it("deletes the last video without deleting the project upward", async () => {
    await remove({ kind: "video", id: "v2" }, 5);
    await remove(videoA, 6);
    assert.ok(exists("projects", "p1") && exists("aigc_folders", "fp-p1"));
    assert.equal(db.count("project_videos", "project_id='p1'"), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real request gate (businessLifecycleResponse): while a video or language deletion awaits completion or retry,
// no request may write into it, whatever reference the request carries; siblings and project reads keep working.
import { businessLifecycleResponse } from "../runtime/business-lifecycle-request";

describe("request gate while a video or language deletion is pending", () => {
  beforeEach(business);
  const handled: string[] = [];
  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    const request = new Request(`https://aigc.example.test${path}`, { method, headers: { "content-type": "application/json", "x-lifewood-actor-email": LEAD }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const response = await businessLifecycleResponse(request, db, async () => { handled.push(`${method} ${path}`); return Response.json({ ok: true }); });
    return { status: response.status, code: ((await response.json()) as { code?: string }).code };
  };
  async function pending(target: DeletionTarget, n: number) {
    const preview = await service.preview(LEAD, target);
    await service.start(LEAD, { ...target, submissionId: submission(n), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: [] });
  }
  const refused = (result: { status: number; code?: string }) => assert.deepEqual(result, { status: 404, code: "BUSINESS_DELETED" });

  // A delivery makes its language protected history, so a delivery ID can never point into a pending deletion.
  it("refuses writes by video ID, share token and project-level cascades into a pending language deletion", async () => {
    db.insert("share_links", { id: "share-en", project_id: "p1", file_id: "en-eng", kind: "file", token: "token-en", enabled: 1, creator_email: LEAD, access_count: 0, created_at: "t" });
    await pending({ kind: "language", id: "t-en" }, 20);
    handled.length = 0;
    refused(await call("POST", "/api/workflow", { action: "project.language.add", videoId: "v1" }));
    refused(await call("POST", "/api/shares/unlock", { token: "token-en" }));
    refused(await call("POST", "/api/workflow", { action: "project.deadline", projectId: "p1" }));
    refused(await call("POST", "/api/workflow", { action: "production.save", taskId: "t-en" }));
    assert.deepEqual(handled, [], "nothing reached the handler");
    assert.deepEqual(await call("POST", "/api/workflow", { action: "production.save", taskId: "t-fr" }), { status: 200, code: undefined }, "another video's language stays writable");
    assert.deepEqual(await call("GET", "/api/workflow?projectId=p1"), { status: 200, code: undefined }, "the project can still be read");
  });

  it("refuses new languages by video ID into a pending video deletion, and any later request naming the deleted IDs", async () => {
    await pending({ kind: "video", id: "v1" }, 21);
    refused(await call("POST", "/api/workflow", { action: "project.language.add", videoId: "v1" }));
    assert.deepEqual(await call("POST", "/api/workflow", { action: "project.language.add", videoId: "v2" }), { status: 200, code: undefined });
    await service.resume(LEAD, submission(21));
    refused(await call("POST", "/api/workflow", { action: "project.language.add", videoId: "v1" }));
    refused(await call("GET", "/api/workflow?taskId=t-en"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Overlapping deletions are serialized: a project deletion and a deletion inside it, and any two deletions that touch
// the same stored object (even one only kept), never run at once. The last remaining reference purges the object.
describe("overlapping deletions", () => {
  beforeEach(business);
  const startWith = (target: DeletionTarget, preview: Awaited<ReturnType<typeof service.preview>>, n: number) =>
    service.start(LEAD, { ...target, submissionId: submission(n), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: [] });

  it("refuses a whole-project deletion from an older review while a file-less language deletion is pending, and the reverse", async () => {
    const project = await service.preview(LEAD, { kind: "project", id: "p1" });
    const german = await service.preview(LEAD, { kind: "language", id: "t-de" });
    assert.equal(german.summary.files, 0, "German has no files: nothing but the tree links the two deletions");
    await startWith({ kind: "language", id: "t-de" }, german, 40);
    await assert.rejects(() => startWith({ kind: "project", id: "p1" }, project, 41), (error: unknown) => ["STALE_RECORD", "STALE_DELETION_PREVIEW"].includes(String((error as PublicError).code)));
    assert.equal((await service.resume(LEAD, submission(40))).state, "complete", "the language deletion can still finish");
    business();
    const fresh = await service.preview(LEAD, { kind: "project", id: "p1" });
    const later = await service.preview(LEAD, { kind: "language", id: "t-de" });
    await startWith({ kind: "project", id: "p1" }, fresh, 42);
    await assert.rejects(() => startWith({ kind: "language", id: "t-de" }, later, 43));
  });

  it("serializes two language deletions that reference one stored object, so the last reference purges it exactly once", async () => {
    const english = await service.preview(LEAD, { kind: "language", id: "t-en" });
    const spanish = await service.preview(LEAD, { kind: "language", id: "t-es" });
    assert.ok(english.summary.retainedObjects >= 1 && spanish.summary.retainedObjects >= 1, "each sees the other's reference to k/shared");
    await startWith({ kind: "language", id: "t-en" }, english, 44);
    await assert.rejects(() => startWith({ kind: "language", id: "t-es" }, spanish, 45), "a second deletion touching k/shared waits");
    await service.resume(LEAD, submission(44));
    assert.ok(!purged.includes("k/shared") && exists("aigc_storage_objects", "obj-en-shared"), "Spanish still uses it");
    const again = await service.preview(LEAD, { kind: "language", id: "t-es" });
    await startWith({ kind: "language", id: "t-es" }, again, 46);
    await service.resume(LEAD, submission(46));
    assert.equal(purged.filter(key => key === "k/shared").length, 1, "purged once, by the last reference");
    assert.equal(db.count("aigc_storage_objects", "object_key='k/shared'"), 0, "no ownerless stored object is left");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A file handed over to another language is never left locked: its temporary lock is released in the same
// transaction that moves it, and completion also releases any such lock left by an interrupted older preparation.
describe("files handed over to another language stay available", () => {
  beforeEach(business);
  function spanishUsesEnglishFile() {
    db.insert("production_checkpoints", { id: "cp-es", language_project_id: "t-es", version_number: 1, checkpoint_number: 1, revision_number: 1, editor_email: LEAD, status: "ready", completeness_status: "complete", completeness_json: "{}", project_file_version_id: "es-copy", preview_file_version_id: "", created_at: "t", updated_at: "t" });
    db.insert("task_material_links", { id: "tml", language_project_id: "t-es", checkpoint_id: "cp-es", material_file_id: "lf-en-eng", material_version_id: "en-eng", source_type: "task", created_by: LEAD, created_at: "t" });
  }
  it("releases the moved file's lock in the preparation itself", async () => {
    spanishUsesEnglishFile();
    const preview = await service.preview(LEAD, { kind: "language", id: "t-en" });
    await service.start(LEAD, { kind: "language", id: "t-en", submissionId: submission(50), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: [] });
    assert.equal(db.count("business_deletion_locks", "scope_id='file:lf-en-eng'"), 0);
    await assertBusinessAvailable(db, await businessScopes(db, { fileId: "lf-en-eng" }));
  });
  it("releases a moved file's lock left by an interrupted preparation when the deletion completes", async () => {
    spanishUsesEnglishFile();
    const preview = await service.preview(LEAD, { kind: "language", id: "t-en" });
    await service.start(LEAD, { kind: "language", id: "t-en", submissionId: submission(51), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: [] });
    db.insert("business_deletion_locks", { scope_id: "file:lf-en-eng", job_id: submission(51), created_at: "t" });
    await service.resume(LEAD, submission(51));
    assert.equal(db.count("business_deletion_locks", "scope_id='file:lf-en-eng'"), 0, "the kept file is not treated as deleted");
    assert.ok(db.count("business_deletion_locks", "scope_id='language:t-en'") === 1, "the deleted language keeps its tombstone");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Uploads, covers, share links and hand-over targets around a video or language deletion.
describe("uploads, covers, shares and hand-over targets", () => {
  beforeEach(business);
  const english: DeletionTarget = { kind: "language", id: "t-en" };
  function spanishUsesEnglishFile() {
    db.insert("production_checkpoints", { id: "cp-es", language_project_id: "t-es", version_number: 1, checkpoint_number: 1, revision_number: 1, editor_email: LEAD, status: "ready", completeness_status: "complete", completeness_json: "{}", project_file_version_id: "es-copy", preview_file_version_id: "", created_at: "t", updated_at: "t" });
    db.insert("task_material_links", { id: "tml", language_project_id: "t-es", checkpoint_id: "cp-es", material_file_id: "lf-en-eng", material_version_id: "en-eng", source_type: "task", created_by: LEAD, created_at: "t" });
  }
  const upload = (id: string, fields: Record<string, string>, scopes: string[]) => db.insert("direct_upload_sessions", { id, registration_id: "r", actor_email: LEAD, request_hash: "h",
    payload_json: JSON.stringify({ endpoint: "/api/files", fields, file: { name: "cover.jpg" } }), assets_json: "[]", authority_json: "{}", state: "uploading", scopes_json: JSON.stringify(scopes),
    expires_at: "2099-01-01T00:00:00.000Z", size_bytes: 1, created_at: "t", updated_at: "2026-11-21T07:59:00.000Z" });

  it("refuses while an upload holds the language's stored scope, or an automatic cover targets its version or staged upload", async () => {
    upload("00000000-0000-4000-8000-0000000000a1", {}, ["project:p1", "language:t-en", "video:v1"]);
    await blocked(english, "BUSINESS_OPERATION_IN_PROGRESS");
    business();
    upload("00000000-0000-4000-8000-0000000000a2", { thumbnailForVersionId: "en-shared" }, []);
    await blocked(english, "BUSINESS_OPERATION_IN_PROGRESS");
    business();
    db.insert("production_staged_files", { id: "staged-en", actor_email: LEAD, language_project_id: "t-en", purpose: "final", category: "final", original_name: "cut.mp4", mime_type: "video/mp4", file_kind: "video", size_bytes: 10, checksum_sha256: "a".repeat(64), object_key: "k/staged-en", state: "ready", created_at: "t", updated_at: "t", expires_at: "2099-01-01T00:00:00.000Z" });
    upload("00000000-0000-4000-8000-0000000000a3", { parentUploadId: "staged-en" }, []);
    await blocked(english, "BUSINESS_OPERATION_IN_PROGRESS");
  });

  it("keeps the cover of a version handed over to another language, even though it shares its staged upload's id", async () => {
    spanishUsesEnglishFile();
    db.insert("production_staged_files", { id: "en-eng", actor_email: LEAD, language_project_id: "t-en", purpose: "materials", category: "project", original_name: "en-eng.bin", mime_type: "video/mp4", file_kind: "video", size_bytes: 10, checksum_sha256: "a".repeat(64), object_key: "k/en-eng", state: "committed", committed_version_id: "en-eng", created_at: "t", updated_at: "t", expires_at: "2099-01-01T00:00:00.000Z" });
    db.insert("aigc_file_previews", { file_version_id: "en-eng", object_key: "k/en-eng-cover", mime_type: "image/jpeg", size_bytes: 5, created_by: LEAD, created_at: "t", updated_at: "t" });
    await remove(english, 60);
    assert.equal(db.count("aigc_file_previews", "file_version_id='en-eng'"), 1, "the handed-over version keeps its cover");
    assert.ok(!purged.includes("k/en-eng-cover") && !purged.includes("k/en-eng"));
  });

  it("revokes the deleted language's share links and sessions of a moved file, and keeps other shares", async () => {
    spanishUsesEnglishFile();
    db.insert("share_links", { id: "share-moved", project_id: "p1", file_id: "en-eng", kind: "file", token: "token-moved", enabled: 1, creator_email: LEAD, access_count: 0, created_at: "t" });
    db.insert("share_access_sessions", { token_hash: "session-moved", share_id: "share-moved", expires_at: "2099-01-01T00:00:00.000Z", created_at: "t" });
    db.insert("share_links", { id: "share-sibling", project_id: "p1", file_id: "es-copy", kind: "file", token: "token-sibling", enabled: 1, creator_email: LEAD, access_count: 0, created_at: "t" });
    db.insert("share_access_sessions", { token_hash: "session-sibling", share_id: "share-sibling", expires_at: "2099-01-01T00:00:00.000Z", created_at: "t" });
    const preview = await service.preview(LEAD, english);
    await service.start(LEAD, { ...english, submissionId: submission(61), revision: preview.revision, previewHash: preview.previewHash, confirmationName: preview.name, unlinkShared: [] });
    assert.deepEqual([db.count("share_links", "id='share-moved'"), db.count("share_access_sessions", "share_id='share-moved'")], [0, 0], "revoked with the move");
    assert.deepEqual([db.count("share_links", "id='share-sibling'"), db.count("share_access_sessions", "share_id='share-sibling'")], [1, 1]);
  });

  it("does not hand a file over to a language whose own deletion is pending (and refuses an older review that would)", async () => {
    spanishUsesEnglishFile();
    const olderEnglish = await service.preview(LEAD, english);
    const spanish = await service.preview(LEAD, { kind: "language", id: "t-es" });
    await service.start(LEAD, { kind: "language", id: "t-es", submissionId: submission(62), revision: spanish.revision, previewHash: spanish.previewHash, confirmationName: spanish.name, unlinkShared: [] });
    await blocked(english, "SHARED_FILE_UNASSIGNABLE");
    await assert.rejects(() => service.start(LEAD, { ...english, submissionId: submission(63), revision: olderEnglish.revision, previewHash: olderEnglish.previewHash, confirmationName: olderEnglish.name, unlinkShared: [] }));
    assert.equal(db.sqlite.prepare("SELECT language_project_id AS task FROM aigc_files WHERE id='lf-en-eng'").get()?.task, "t-en", "nothing moved into the language being deleted");
  });

  it("after a file was handed over, the receiving language's own deletion removes it with itself: nothing is left orphaned", async () => {
    spanishUsesEnglishFile();
    const englishPreview = await service.preview(LEAD, english);
    await service.start(LEAD, { ...english, submissionId: submission(64), revision: englishPreview.revision, previewHash: englishPreview.previewHash, confirmationName: englishPreview.name, unlinkShared: [] });
    // English and Spanish also share a stored object, so Spanish's deletion waits for English to complete.
    await service.resume(LEAD, submission(64));
    assert.equal(db.sqlite.prepare("SELECT language_project_id AS task FROM aigc_files WHERE id='lf-en-eng'").get()?.task, "t-es");
    const spanish = await service.preview(LEAD, { kind: "language", id: "t-es" });
    await service.start(LEAD, { kind: "language", id: "t-es", submissionId: submission(65), revision: spanish.revision, previewHash: spanish.previewHash, confirmationName: spanish.name, unlinkShared: [] });
    await service.resume(LEAD, submission(65));
    assert.equal(db.count("aigc_files", "language_project_id IN ('t-en','t-es')"), 0);
    assert.equal(db.count("aigc_files", "folder_id NOT IN (SELECT id FROM aigc_folders)"), 0, "no file points at a vanished folder");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Deseret-linked projects: only videos and languages the integration actually references are protected; a video or
// language AIGC created later and never linked can be deleted on its own. An unreadable integration record refuses.
describe("videos and languages in a Deseret-linked project", () => {
  beforeEach(business);
  const link = (values: Record<string, unknown>) => db.insert("deseret_project_links", { id: "p1", deseret_project_id: "db-1", source_revision: "s", submission_version: 1, snapshot_json: "{}",
    state_json: JSON.stringify({ stage: "production", scenes: [], packages: [] }), native_video_ids: "[\"v1\"]", native_task_ids: "[\"t-en\",\"t-es\"]", revision: 1, created_by: LEAD, created_at: "t", updated_at: "t", ...values });

  it("protects what the integration references: native ids, scenes or packages, archives and handovers, and unreadable records", async () => {
    link({});
    await blocked({ kind: "language", id: "t-es" }, "DESERET_SUBITEM_PROTECTED");
    await blocked({ kind: "video", id: "v1" }, "DESERET_SUBITEM_PROTECTED");
    business();
    link({ native_task_ids: "[]", native_video_ids: "[]", state_json: JSON.stringify({ stage: "storyboard_review", scenes: [{ id: "s1", languageTaskId: "t-fr", fileVersionId: "fr-eng" }], packages: [] }) });
    await blocked({ kind: "language", id: "t-fr" }, "DESERET_SUBITEM_PROTECTED");
    business();
    link({ native_task_ids: "[]", native_video_ids: "[]" });
    db.insert("deseret_production_archives", { id: "arch-de", project_id: "p1", language_project_id: "t-de", archive_number: 1, created_by_email: LEAD, next_steps: "", created_at: "t" });
    await blocked({ kind: "language", id: "t-de" }, "DESERET_SUBITEM_PROTECTED");
    business();
    link({ native_task_ids: "not json" });
    await blocked({ kind: "language", id: "t-fr" }, "DESERET_SUBITEM_PROTECTED");
  });

  it("deletes a video and a language AIGC added later that the integration never referenced", async () => {
    link({});
    assert.equal((await remove({ kind: "language", id: "t-fr" }, 70)).status.state, "complete", "French under the AIGC-only video");
    assert.equal((await remove({ kind: "video", id: "v2" }, 71)).status.state, "complete");
    assert.ok(exists("deseret_project_links", "p1") && exists("language_projects", "t-en") && exists("project_videos", "v1"), "the integration and its linked items are untouched");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// After deletions: an empty project shows no removed people and stays open for new videos and languages, and a new
// video gets a code that never collides with the remaining ones (gaps from deleted videos, beyond VID-999).
import { nextVideoCode } from "../lib/video-code";

describe("the parent after video and language deletions", () => {
  beforeEach(business);
  it("clears removed people and reopens an empty project once its last language version is gone", async () => {
    db.sqlite.prepare("UPDATE projects SET editor_email='old-editor@example.test', reviewer_email='old-qc@example.test', status='已终止' WHERE id='p1'").run();
    await remove({ kind: "video", id: "v1" }, 80);
    await remove({ kind: "video", id: "v2" }, 81);
    assert.deepEqual({ ...db.sqlite.prepare("SELECT editor_email, reviewer_email, status, deleted_at FROM projects WHERE id='p1'").get() as object },
      { editor_email: null, reviewer_email: null, status: "待分配", deleted_at: null });
  });
  it("numbers a new video past the highest remaining code, skipping gaps and continuing after VID-999", () => {
    assert.equal(nextVideoCode(["VID-001", "VID-003"]), "VID-004", "after deleting VID-002 the next is not VID-003 again");
    assert.equal(nextVideoCode([]), "VID-001");
    assert.equal(nextVideoCode(["VID-999"]), "VID-1000");
    assert.equal(nextVideoCode(["VID-9007199254740993"]), "VID-9007199254740994");
    assert.equal(nextVideoCode(["VID-1000", "VID-002", "LEGACY"]), "VID-1001");
  });
});

it("previews the exact storage blocker and refuses to start until storage matches", async () => {
  const { permanentObjectStore } = await import("../runtime/permanent-object-store");
  business();
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", LIFEWOOD_ENV: "test", MYSQL_HOST: "127.0.0.1", MYSQL_DATABASE: "lifewood_aigc_test", MYSQL_USER: "lifewood_test",
    MYSQL_PASSWORD: "test", WASABI_BUCKET: "aigc-dev", WASABI_PREFIX: "lifewood-test/app/", WASABI_REGION: "ap-southeast-1",
    WASABI_ENDPOINT: "https://s3.ap-southeast-1.wasabisys.com", WASABI_ACCESS_KEY_ID: "test", WASABI_SECRET_ACCESS_KEY: "test",
    LIFEWOOD_PERMANENT_DELETE_ENABLED: "false", LIFEWOOD_PERMANENT_DELETE_RESOURCE: "" };
  const guarded = createBusinessDeletionService({ db, storage: permanentObjectStore(env),
    async authority(email) { return { actor: { email, accountId: "acc-lead", revision: 1, access: "project" }, condition: "1=1", values: [] }; } });
  const target = { kind: "language", id: "t-en" } as const;
  for (const [flag, resource, reason] of [
    ["false", "", "PERMANENT_DELETION_DISABLED"],
    ["true", "wrong-resource", "PERMANENT_DELETION_RESOURCE_MISMATCH"],
    ["true", "lifewood_aigc_test:aigc-dev:lifewood-test/app/", "PERMANENT_DELETION_LOCATION_MISMATCH"],
  ]) {
    env.LIFEWOOD_PERMANENT_DELETE_ENABLED = flag;
    env.LIFEWOOD_PERMANENT_DELETE_RESOURCE = resource;
    const result = await guarded.preview(LEAD, target);
    assert.deepEqual(result.availability, { enabled: false, reason });
    await assert.rejects(guarded.start(LEAD, { ...target, submissionId: submission(1), revision: result.revision,
      previewHash: result.previewHash, confirmationName: result.name }), (err: unknown) => err instanceof PublicError && err.code === reason);
    assert.equal(db.count("business_deletion_jobs"), 0);
  }
});

describe("permanent deletion of publisher snapshot copies", () => {
  beforeEach(business);
  for (const kind of ["project", "customer"] as const) {
    it(`deletes only the registered publisher snapshot and its multipart handles under a ${kind}`, async () => {
      const owner = "a".repeat(64);
      const key = `clients/c1/projects/p1/publisher-review/${owner}`;
      const snapshot = { key, owner, bucket:"aigc", region:"sg", prefix:"sg/", endpoint:"https://sg.example.test" };
      const aborted: string[] = [], asserted: string[] = [];
      service = createBusinessDeletionService({
        db, now: () => NOW,
        storage: {
          async assertReady() {}, async purge(relative) { purged.push(relative); },
          async assertOwned(relative, claims) {
            assert.deepEqual(claims.map(({metadataKey,owner}) => ({metadataKey,owner})), [{ metadataKey:"publisher-source", owner }]);
            asserted.push(relative);
          },
          async abortMultipart(relative, handle) { assert.equal(relative,key); aborted.push(handle); },
        },
        async authority(email) { return { actor:{email,accountId:"acc-lead",revision:1,access:"project"}, condition:"1=1", values:[] }; },
      });
      db.insert("deseret_material_tasks", {id:"publisher-transfer", project_id:"p1", source_revision:"brief-v1", file_id:"en-eng",file_version:1,
        manifest_json:"{}", direction:"aigc_to_deseret", state:"ready", attempts:2,created_at:"t",updated_at:"t",next_attempt_at:"t",
        target_json:JSON.stringify({plan:{source:{objectKey:"shared-source"},target:{objectKey:"publisher-destination"}},
          peerUploadId:"remote-upload",publisherSnapshots:[snapshot,{...snapshot,uploadId:"local-1"},{...snapshot,uploadId:"local-2"}]})});
      const {status} = await remove({kind,id:kind==="project" ? "p1" : "c1"});
      assert.equal(status.state,"complete");
      assert.deepEqual(asserted,[key]);
      assert.deepEqual(aborted.sort(),["local-1","local-2"]);
      assert.ok(purged.includes(key));
      assert.ok(!purged.includes("shared-source") && !purged.includes("publisher-destination"));
    });
  }
});
