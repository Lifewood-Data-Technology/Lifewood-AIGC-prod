// Internal Deseret production archives: an immutable, numbered record per language task of the engineering file version
// to continue from, plus an optional preview, materials and next steps. Independent of daily reports. Registered
// versions must be live formal versions of the same task; validity is recomputed when read; the task's current
// editor (after any number of handovers) can read every archived version. Nothing here is ever sent to Deseret.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { archiveSelection, archiveStatements, batchHandoverCheckpoint, deseretHandoverStatements, engineeringFolderGuard, nativeArchiveFiles, publicationHandoverGuard, plannedHandoverArchive, savedArchiveVersionsGuard, taskArchives } from "../db/deseret-production-archive";
import { productionReadableVersionQuery } from "../db/production-file-access";
import { PublicError } from "../lib/security-controls";
import { sqliteDatabase } from "./support/sqlite-database";
import { createDeseretIntegrationJobs } from "../db/deseret-integration-jobs";
import type { DeseretIntegrationState, DeseretScene } from "../lib/deseret-workspace";
import { createHarness, finalReviewState, LEAD, MAKER, OTHER_MAKER, OTHER_QC, PROJECT, QC, type Harness } from "./support/deseret-harness";

export const SECRET = "CONFIDENTIAL-ARCHIVE-NOTE";
let h: Harness;
/** A live formal version of a task in the given folder (03.project = engineering files). */
/** By default the task's own editor uploaded it (task-1: MAKER, task-2: OTHER_MAKER). */
export function version(harness: Harness, id: string, taskId: string, folderCode: string, mimeType = "application/octet-stream", projectId = PROJECT, createdBy = taskId === "task-2" ? OTHER_MAKER : MAKER) {
  const folder = `folder-${taskId}-${folderCode}`;
  harness.db.sqlite.prepare("INSERT OR IGNORE INTO aigc_folders (id,parent_folder_id,language_project_id,folder_code,deleted_at) VALUES (?,?,?,?,NULL)").run(folder, `folder-${taskId}-03`, taskId, folderCode);
  harness.addNative({ id, taskId, directory: "03_项目制作", status: "available", name: `${id}.bin`, mimeType, size: 10, sha256: "e".repeat(64), projectId, createdBy });
  harness.db.sqlite.prepare("UPDATE aigc_files SET folder_id=? WHERE id=?").run(folder, `logical-${id}`);
}
export const register = async (harness: Harness, taskId: string, input: Parameters<typeof archiveSelection>[3], email = MAKER) => {
  const selection = await archiveSelection(harness.db, PROJECT, taskId, input, email);
  const ok = harness.db.sqlite.prepare(`SELECT ${selection.guard.sql} AS ok`).get(...selection.guard.values) as { ok: number };
  assert.equal(ok.ok, 1, "the write guard holds");
  for (const statement of selection.statements) await statement.run();
  return selection.id;
};
const rejectsInvalid = (run: () => Promise<unknown>) => assert.rejects(run, (error: unknown) => {
  assert.ok(error instanceof PublicError, String(error));
  assert.equal(error.code, "DESERET_ARCHIVE_INVALID");
  return true;
});

describe("archive registration", () => {
  beforeEach(() => {
    h = createHarness(finalReviewState());
    version(h, "eng-v1", "task-1", "03.project");
    version(h, "eng-v2", "task-1", "03.project");
    version(h, "preview-1", "task-1", "03.preview", "video/mp4");
    version(h, "voice-1", "task-1", "03.voice", "audio/mpeg");
    version(h, "eng-t2", "task-2", "03.project");
  });

  it("keeps every saved native archive version inside its original task and project through commit", () => {
    const guard = savedArchiveVersionsGuard(["eng-v1", "preview-1"], "task-1", PROJECT);
    const holds = () => (h.db.sqlite.prepare(`SELECT ${guard.sql} AS ok`).get(...guard.values) as { ok: number }).ok;
    assert.equal(holds(), 1);
    h.db.sqlite.prepare("UPDATE project_files SET language_project_id='task-2' WHERE id='preview-1'").run();
    assert.equal(holds(), 0);
    h.db.sqlite.prepare("UPDATE project_files SET language_project_id='task-1',project_id='another-project' WHERE id='preview-1'").run();
    assert.equal(holds(), 0);
  });

  it("records the engineering version, optional preview, materials and next steps, numbered per task", async () => {
    const first = await register(h, "task-1", { projectVersionId: "eng-v1", previewVersionId: "preview-1", materialVersionIds: ["voice-1"], nextSteps: "Finish scenes 9-12" });
    const second = await register(h, "task-1", { projectVersionId: "eng-v2" });
    const other = await register(h, "task-2", { projectVersionId: "eng-t2" }, OTHER_MAKER);
    const [latest, earliest] = await taskArchives(h.db, PROJECT, ["task-1"]);
    assert.deepEqual([latest.id, latest.number, earliest.id, earliest.number], [second, 2, first, 1]);
    assert.deepEqual({ project: earliest.projectVersion.id, preview: earliest.preview?.id, materials: earliest.materials.map(file => file.id), next: earliest.nextSteps, valid: earliest.valid, by: earliest.createdBy },
      { project: "eng-v1", preview: "preview-1", materials: ["voice-1"], next: "Finish scenes 9-12", valid: true, by: MAKER });
    assert.equal((await taskArchives(h.db, PROJECT, ["task-2"]))[0].id, other);
    assert.equal((await taskArchives(h.db, PROJECT, ["task-2"]))[0].number, 1, "numbers are per task");
  });

  it("accepts only live formal versions of the same task, with an engineering file and a video preview", async () => {
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-t2" }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "voice-1" }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "staged-not-registered" }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v1", previewVersionId: "voice-1" }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v1", materialVersionIds: ["eng-t2"] }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v1", materialVersionIds: Array.from({ length: 51 }, (_, n) => `m${n}`) }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v1", nextSteps: "x".repeat(4001) }, MAKER));
    h.db.sqlite.prepare("UPDATE project_files SET deleted_at='2026-11-21' WHERE id='eng-v2'").run();
    await rejectsInvalid(() => archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v2" }, MAKER));
    await rejectsInvalid(() => archiveSelection(h.db, "aigc-project-2", "task-1", { projectVersionId: "eng-v1" }, MAKER));
  });

  it("re-checks in the write transaction that the engineering version is still filed under Project files", async () => {
    const selection = await archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v1" }, MAKER);
    const holds = (guard: { sql: string; values: (string | number | null)[] }) => (h.db.sqlite.prepare(`SELECT ${guard.sql} AS ok`).get(...guard.values) as { ok: number }).ok;
    const native = engineeringFolderGuard("eng-v1", "task-1");
    assert.deepEqual([holds(selection.guard), holds(native)], [1, 1]);
    h.db.sqlite.prepare("UPDATE aigc_files SET folder_id='folder-task-1-03.preview' WHERE id='logical-eng-v1'").run();
    assert.deepEqual([holds(selection.guard), holds(native)], [0, 0], "moved out of Project files after the form loaded: not an archive");
  });

  it("re-checks liveness in the write transaction", async () => {
    const selection = await archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: "eng-v1", materialVersionIds: ["voice-1"] }, MAKER);
    h.db.sqlite.prepare("UPDATE aigc_files SET deleted_at='2026-11-21' WHERE id='logical-voice-1'").run();
    assert.equal((h.db.sqlite.prepare(`SELECT ${selection.guard.sql} AS ok`).get(...selection.guard.values) as { ok: number }).ok, 0);
  });

  it("shows an archive as invalid, naming the file, once a referenced version is no longer live", async () => {
    await register(h, "task-1", { projectVersionId: "eng-v1", materialVersionIds: ["voice-1"] });
    h.db.sqlite.prepare("UPDATE project_files SET status='deleted' WHERE id='voice-1'").run();
    const [archive] = await taskArchives(h.db, PROJECT, ["task-1"]);
    assert.equal(archive.valid, false);
    assert.deepEqual(archive.missing, ["voice-1.bin"]);
    assert.equal(archive.materials[0].live, false);
  });
});

describe("the engineering file is decided by where it really is", () => {
  const decide = (input: Partial<Parameters<typeof nativeArchiveFiles>[0]>) => nativeArchiveFiles({ ids: [], staged: [], existing: [], projectVersionId: "", ...input });
  const invalid = (run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof PublicError && error.code === "DESERET_ARCHIVE_INVALID");

  it("accepts a new upload filed as an engineering file, or a saved version that is in Project files", () => {
    assert.deepEqual(decide({ ids: ["new-eng", "new-voice"], staged: [{ id: "new-eng", category: "project", kind: "other" }, { id: "new-voice", category: "voice", kind: "audio" }], projectVersionId: "new-eng" }),
      [{ id: "new-eng", role: "project" }, { id: "new-voice", role: "material" }]);
    assert.deepEqual(decide({ ids: ["saved-eng", "saved-preview"], existing: [{ id: "saved-eng", folderCode: "03.project", kind: "other" }, { id: "saved-preview", folderCode: "03.preview", kind: "video" }],
      projectVersionId: "saved-eng", previewVersionId: "saved-preview" }), [{ id: "saved-eng", role: "project" }, { id: "saved-preview", role: "preview" }]);
  });

  it("refuses a saved version outside Project files whatever the form says, a non-video preview and files outside the selection", () => {
    invalid(() => decide({ ids: ["saved-preview"], existing: [{ id: "saved-preview", folderCode: "03.preview", kind: "video" }], projectVersionId: "saved-preview" }));
    invalid(() => decide({ ids: ["new-voice"], staged: [{ id: "new-voice", category: "voice", kind: "audio" }], projectVersionId: "new-voice" }));
    invalid(() => decide({ ids: ["saved-eng", "saved-voice"], existing: [{ id: "saved-eng", folderCode: "03.project", kind: "other" }, { id: "saved-voice", folderCode: "03.voice", kind: "audio" }], projectVersionId: "saved-eng", previewVersionId: "saved-voice" }));
    invalid(() => decide({ ids: ["saved-eng"], existing: [{ id: "saved-eng", folderCode: "03.project", kind: "other" }], projectVersionId: "elsewhere" }));
    invalid(() => decide({ ids: ["saved-eng"], existing: [{ id: "saved-eng", folderCode: "03.project", kind: "other" }], projectVersionId: "saved-eng", previewVersionId: "saved-eng" }));
  });

  it("treats an archive whose engineering file is not in Project files as invalid (the gate accepts only valid archives)", async () => {
    h = createHarness(finalReviewState());
    version(h, "misfiled", "task-1", "03.preview", "video/mp4");
    const misfiled = archiveStatements(h.db, { projectId: PROJECT, taskId: "task-1", email: MAKER, now: "2026-11-20T00:00:00.000Z", files: [{ id: "misfiled", role: "project" }] });
    for (const statement of misfiled.statements) await statement.run();
    const [archive] = await taskArchives(h.db, PROJECT, ["task-1"]);
    assert.equal(archive.valid, false, "a historical wrong binding is not a valid engineering archive");
    assert.deepEqual(archive.missing, ["misfiled.bin"]);
  });
});

describe("archived versions are readable by the task's current editor only", () => {
  const db = sqliteDatabase();
  db.sqlite.exec(`
    CREATE TABLE clients (id TEXT PRIMARY KEY, deleted_at TEXT, status TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, client_id TEXT);
    CREATE TABLE language_projects (id TEXT PRIMARY KEY, project_id TEXT, editor_email TEXT, reviewer_email TEXT);
    CREATE TABLE aigc_folders (id TEXT PRIMARY KEY, parent_folder_id TEXT, folder_code TEXT, language_project_id TEXT, node_type TEXT, path_cache TEXT, deleted_at TEXT);
    CREATE TABLE aigc_files (id TEXT PRIMARY KEY, folder_id TEXT, language_project_id TEXT, deleted_at TEXT, status TEXT, source TEXT);
    CREATE TABLE aigc_file_versions (id TEXT PRIMARY KEY, file_id TEXT, created_by TEXT);
    CREATE TABLE project_files (id TEXT PRIMARY KEY, deleted_at TEXT, status TEXT, source TEXT);
    CREATE TABLE asset_collections (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE asset_collection_files (collection_id TEXT, file_id TEXT);
    CREATE TABLE production_flow_files (file_version_id TEXT, event_id TEXT); CREATE TABLE production_flow_events (id TEXT, language_project_id TEXT);
    CREATE TABLE production_checkpoint_files (file_version_id TEXT, checkpoint_id TEXT);
    CREATE TABLE handover_records (checkpoint_id TEXT, language_project_id TEXT, to_user_email TEXT, status TEXT);
    CREATE TABLE production_final_submission_files (file_version_id TEXT, submission_id TEXT); CREATE TABLE production_final_submissions (id TEXT, language_project_id TEXT);
    CREATE TABLE deseret_archive_files (archive_id TEXT, language_project_id TEXT, file_version_id TEXT, role TEXT);
    INSERT INTO clients VALUES ('c', NULL, 'Active'); INSERT INTO projects VALUES ('p', 'c');
    INSERT INTO language_projects VALUES ('t1', 'p', 'editor-a@example.test', 'qc@example.test'), ('t2', 'p', 'other@example.test', 'qc@example.test');
    INSERT INTO aigc_folders VALUES ('f-t1', NULL, '03.project', 't1', 'folder', '/p/t1', NULL), ('f-t2', NULL, '03.project', 't2', 'folder', '/p/t2', NULL);`);
  for (const [id, task, author] of [["a-eng", "t1", "editor-a@example.test"], ["b-eng", "t1", "editor-b@example.test"], ["draft", "t1", "editor-a@example.test"], ["t2-eng", "t2", "other@example.test"]]) {
    db.sqlite.prepare("INSERT INTO aigc_files VALUES (?,?,?,NULL,'available','project')").run(`file-${id}`, `f-${task}`, task);
    db.sqlite.prepare("INSERT INTO aigc_file_versions VALUES (?,?,?)").run(id, `file-${id}`, author);
    db.sqlite.prepare("INSERT INTO project_files VALUES (?,NULL,'available','project')").run(id);
  }
  db.sqlite.prepare("INSERT INTO deseret_archive_files VALUES ('arch-a','t1','a-eng','project'),('arch-b','t1','b-eng','project'),('arch-o','t2','t2-eng','project')").run();
  const readable = (email: string) => {
    const query = productionReadableVersionQuery(email);
    return (db.sqlite.prepare(query.sql).all(...query.values) as { id: string }[]).map(row => row.id).sort();
  };

  it("follows the task through a chain of editors without exposing private drafts or other tasks", () => {
    // A registered a.eng and kept a private draft; B took over and archived b.eng; now C holds the task.
    db.sqlite.prepare("UPDATE language_projects SET editor_email='editor-c@example.test' WHERE id='t1'").run();
    assert.deepEqual(readable("editor-c@example.test"), ["a-eng", "b-eng"]);
    assert.deepEqual(readable("editor-a@example.test"), [], "the previous editor no longer reads the task");
    assert.deepEqual(readable("editor-b@example.test"), []);
    assert.deepEqual(readable("other@example.test"), ["t2-eng"], "another task's editor reads only their own task");
    assert.deepEqual(readable(QC), [], "a reviewer gains nothing from archives");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Integration service: projection, actions and the publication gate.
const scene = (id: string, order: number, taskId: string, fileVersionId: string): DeseretScene =>
  ({ id, order, version: 1, duration: 10, characterIds: [], voiceId: "", fileVersionId, languageTaskId: taskId });
/** A storyboard round ready to publish: one scene in task-1 (MAKER) and one in task-2 (OTHER_MAKER). */
function roundState(): DeseretIntegrationState {
  return { ...finalReviewState(), stage: "production", packages: [], revisionSceneIds: [], revision: 4,
    scenes: [scene("scene-a", 1, "task-1", "video-a"), scene("scene-b", 2, "task-2", "video-b")] };
}
let request = 0;
const command = (email: string, action: string, payload: Record<string, unknown>) =>
  h.service.command(email, PROJECT, { requestId: `req-${++request}`, expectedRevision: h.state().revision, action, payload });
const rejectsCode = (run: () => Promise<unknown>, code: string, message?: RegExp) => h.rejectsUnchanged(async () => {
  try { await run(); } catch (error) { if (message) assert.match(String((error as Error).message), message); throw error; }
}, code);
function setupRound() {
  h = createHarness(roundState());
  request = 0;
  h.db.sqlite.prepare("UPDATE language_projects SET status='制作中' WHERE project_id=?").run(PROJECT);
  for (const [id, task] of [["video-a", "task-1"], ["video-b", "task-2"]])
    h.addNative({ id, taskId: task, directory: "03_项目制作", status: "qc_approved", name: `${id}.mp4`, mimeType: "video/mp4", size: 4096, sha256: "c".repeat(64), qualityApproved: true });
  version(h, `eng-${SECRET}-1`, "task-1", "03.project");
  version(h, `eng-${SECRET}-2`, "task-2", "03.project");
  version(h, "voice-1", "task-1", "03.voice", "audio/mpeg");
}
const archiveOf = (taskId: string) => h.db.sqlite.prepare("SELECT id FROM deseret_production_archives WHERE language_project_id=? ORDER BY archive_number DESC").get(taskId) as { id: string } | undefined;

describe("editors archive only versions they may read", () => {
  const FORMER = "former@example.test";
  beforeEach(() => { setupRound(); version(h, "former-draft", "task-1", "03.project", "application/octet-stream", PROJECT, FORMER); });

  it("hides a former editor's private draft from the editor's candidates and refuses to archive it; the lead keeps project access", async () => {
    const editor = await h.service.workspace(MAKER, PROJECT);
    assert.ok(editor.archiveCandidates?.some(file => file.id === `eng-${SECRET}-1`), "the editor's own upload is offered");
    assert.ok(!editor.archiveCandidates?.some(file => file.id === "former-draft"), "a draft the editor cannot read is not offered");
    await rejectsCode(() => command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: "former-draft" }), "DESERET_ARCHIVE_INVALID");
    const readable = productionReadableVersionQuery(MAKER, "former-draft");
    assert.equal(h.db.sqlite.prepare(readable.sql).all(...readable.values).length, 0, "registering is not a way to gain access");
    const lead = await h.service.workspace(LEAD, PROJECT);
    assert.ok(lead.archiveCandidates?.some(file => file.id === "former-draft"));
    await command(LEAD, "archive.register", { taskId: "task-1", projectVersionId: "former-draft" });
  });

  it("re-checks the editor's read access in the write transaction", async () => {
    const selection = await archiveSelection(h.db, PROJECT, "task-1", { projectVersionId: `eng-${SECRET}-1` }, MAKER, "2026-11-21T00:00:00.000Z", productionReadableVersionQuery(MAKER));
    const holds = () => (h.db.sqlite.prepare(`SELECT ${selection.guard.sql} AS ok`).get(...selection.guard.values) as { ok: number }).ok;
    assert.equal(holds(), 1);
    h.db.sqlite.prepare("UPDATE aigc_file_versions SET created_by=? WHERE id=?").run(FORMER, `eng-${SECRET}-1`);
    assert.equal(holds(), 0, "a version the editor can no longer read fails the guard");
  });
});

describe("integration service: internal archives", () => {
  beforeEach(setupRound);

  it("lets an editor archive their own task during internal QC and publisher review, and the lead any task", async () => {
    h.db.sqlite.prepare("UPDATE language_projects SET status='待质检' WHERE id='task-1'").run();
    h.db.sqlite.prepare("UPDATE deseret_project_links SET state_json=json_set(state_json,'$.stage','storyboard_review')").run();
    const workspace = await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1`, materialVersionIds: ["voice-1"], nextSteps: SECRET });
    assert.ok(workspace.actions.includes("archive.register"));
    assert.deepEqual(workspace.archives?.map(archive => [archive.taskId, archive.number, archive.nextSteps]), [["task-1", 1, SECRET]]);
    assert.ok(workspace.archiveCandidates?.length && workspace.archiveCandidates.every(file => file.taskId === "task-1"), "an editor sees only their own task's files");
    await rejectsCode(() => command(MAKER, "archive.register", { taskId: "task-2", projectVersionId: `eng-${SECRET}-2` }), "DESERET_FORBIDDEN");
    await command(LEAD, "archive.register", { taskId: "task-2", projectVersionId: `eng-${SECRET}-2` });
    assert.equal((await h.service.workspace(LEAD, PROJECT)).archives?.length, 2);
  });

  it("refuses closed or paused tasks and never shows archives to quality reviewers", async () => {
    h.db.sqlite.prepare("UPDATE language_projects SET status='已交付' WHERE id='task-1'").run();
    await rejectsCode(() => command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1` }), "DESERET_ARCHIVE_CLOSED");
    h.db.sqlite.prepare("UPDATE language_projects SET status='已暂停' WHERE id='task-1'").run();
    await rejectsCode(() => command(LEAD, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1` }), "DESERET_ARCHIVE_CLOSED");
    h.db.sqlite.prepare("UPDATE language_projects SET status='制作中' WHERE id='task-1'").run();
    await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1` });
    for (const reviewer of [QC, OTHER_QC]) {
      const workspace = await h.service.workspace(reviewer, PROJECT);
      assert.ok(!workspace.archives && !workspace.archiveCandidates && !workspace.handovers && !workspace.packageSources, reviewer);
      assert.ok(!JSON.stringify(workspace).includes(SECRET));
    }
  });
});

describe("integration service: publication without engineering archives", () => {
  beforeEach(setupRound);
  const publish = () => command(LEAD, "package.publish", { phase: "storyboard" });

  it("publishes without a source selection and leaves historical source links intact", async () => {
    await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1` });
    const archiveId = archiveOf("task-1")!.id;
    h.db.sqlite.prepare("INSERT INTO deseret_package_sources(id,project_id,package_id,scene_id,scene_version,language_project_id,video_version_id,archive_id,confirmed_by_email,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("old-source", PROJECT, "old-package", "scene-a", 1, "task-1", "video-a", archiveId, LEAD, "2026-11-20");
    const workspace = await publish();
    assert.equal(h.state().stage, "storyboard_review");
    assert.deepEqual(workspace.packageSources?.map(item => [item.packageId, item.archiveId]), [["old-package", archiveId]]);
  });

  it("continues to reject a video awaiting internal quality approval", async () => {
    h.db.sqlite.prepare("UPDATE project_files SET status='uploaded' WHERE id='video-a'").run();
    await rejectsCode(publish, "DESERET_QUALITY_REQUIRED");
    assert.equal(h.state().packages.length, 0);
  });

  it("preserves the pending staffing handover check without an archive", async () => {
    h.db.sqlite.prepare("INSERT INTO handover_records (id,language_project_id,status) VALUES ('h-pending','task-1','pending')").run();
    await rejectsCode(publish, "DESERET_HANDOVER_PENDING", /task-1/);
  });

  it("keeps every archive detail out of publisher events, transfer tasks, integration state and resends", async () => {
    await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1`, materialVersionIds: ["voice-1"], nextSteps: SECRET });
    await command(LEAD, "archive.register", { taskId: "task-2", projectVersionId: `eng-${SECRET}-2`, nextSteps: SECRET });
    const archiveIds = [archiveOf("task-1")!.id, archiveOf("task-2")!.id];
    await publish();
    // The transfer worker finishes; the jobs worker queues review.published and delivers it; the lead then resends.
    for (const task of h.db.sqlite.prepare("SELECT id,manifest_json FROM deseret_material_tasks WHERE direction='aigc_to_deseret'").all() as { id: string; manifest_json: string }[]) {
      const manifest = JSON.parse(task.manifest_json);
      h.db.sqlite.prepare("UPDATE deseret_material_tasks SET state='ready', target_json=? WHERE id=?")
        .run(JSON.stringify({ ...manifest, storageProfileId: "deseret-main", objectKey: `aigc-review/x/${manifest.id}.mp4`, purpose: "storyboard_video" }), task.id);
    }
    const sent: string[] = [];
    const jobs = createDeseretIntegrationJobs({ db: h.db, clock: () => Date.parse("2026-11-21T00:00:00.000Z"), reportDiagnostic: () => {},
      planTransfer: () => { throw new Error("not used"); }, transferFile: async () => { throw new Error("not used"); }, sourceReceipt: async () => { throw new Error("not used"); },
      registerIncoming: async () => { throw new Error("not used"); }, projectAuthority: async () => ({ sql: "1=1", values: [] }), withProject: (_id: string, work: () => unknown) => work(),
      deliver: async (body: string) => { sent.push(body); }, confirmReceipt: async () => false } as unknown as Parameters<typeof createDeseretIntegrationJobs>[0]);
    await jobs.reconcile(PROJECT);
    h.db.sqlite.prepare("UPDATE deseret_outbox SET sequence=rowid").run();
    for (let i = 0; i < 5; i += 1) await jobs.outboxTick(new AbortController().signal);
    const first = sent.length;
    h.db.sqlite.prepare("UPDATE deseret_outbox SET state='failed'").run();
    await command(LEAD, "outbox.retry", {});
    for (let i = 0; i < 5; i += 1) await jobs.outboxTick(new AbortController().signal);
    assert.ok(sent.slice(0, first).some(body => JSON.parse(body).type === "review.published"), "the round was published");
    assert.ok(sent.length > first, "the lead's resend went out again");
    const external = JSON.stringify({ sent, outbox: h.db.sqlite.prepare("SELECT body_json FROM deseret_outbox").all(),
      transfers: h.db.sqlite.prepare("SELECT manifest_json,target_json FROM deseret_material_tasks").all(), state: h.db.sqlite.prepare("SELECT state_json FROM deseret_project_links").all() });
    for (const needle of [SECRET, "voice-1", "eng-", ...archiveIds, "archive", "nextSteps", "next_steps"]) assert.ok(!external.includes(needle), `external data carries ${needle}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Editor handovers on Deseret projects: staffing and the incoming editor's verification are separate results.
describe("Deseret editor handovers", () => {
  const FORMER = "former@example.test";
  beforeEach(setupRound);
  /** A staffing change of task-1 from FORMER to MAKER, as the planned, emergency or batch flow records it. */
  async function handOver(kind: "planned" | "emergency" | "batch", now = "2026-11-20T08:00:00.000Z", handoverId = `handover-${kind}`) {
    for (const statement of (await deseretHandoverStatements(h.db, { handoverId, projectId: PROJECT, taskId: "task-1", kind, fromEmail: FORMER, toEmail: MAKER, now })).statements) await statement.run();
    return handoverId;
  }

  it("records each kind with the newest valid archive (or none), pending the incoming editor's check; ordinary projects get nothing", async () => {
    await handOver("emergency");
    await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1` });
    const archive = archiveOf("task-1")!.id;
    await handOver("planned", "2026-11-20T08:30:00.000Z");
    await handOver("batch", "2026-11-20T08:45:00.000Z");
    const handovers = (await h.service.workspace(LEAD, PROJECT)).handovers!;
    assert.deepEqual(handovers.map(item => [item.kind, item.archiveId ?? null, item.verification, item.from, item.to]),
      [["batch", archive, "pending", FORMER, MAKER], ["planned", archive, "pending", FORMER, MAKER], ["emergency", null, "pending", FORMER, MAKER]]);
    assert.equal(await plannedHandoverArchive(h.db, PROJECT, "task-1"), archive);
    assert.deepEqual((await deseretHandoverStatements(h.db, { handoverId: "native", projectId: "aigc-project-2", taskId: "task-x", kind: "batch", fromEmail: FORMER, toEmail: MAKER, now: "2026-11-20T08:00:00.000Z" })).statements, []);
    assert.equal(await plannedHandoverArchive(h.db, "aigc-project-2", "task-x"), null);
    h.db.sqlite.prepare("UPDATE project_files SET deleted_at='2026-11-21' WHERE id=?").run(`eng-${SECRET}-1`);
    assert.equal(await plannedHandoverArchive(h.db, PROJECT, "task-1"), null, "an invalid archive cannot replace the checkpoint");
  });

  it("lets only the incoming editor verify, requires a note for missing work, and accepts one result", async () => {
    const id = await handOver("emergency");
    assert.ok((await h.service.workspace(MAKER, PROJECT)).actions.includes("handover.verify"));
    await rejectsCode(() => command(OTHER_MAKER, "handover.verify", { handoverId: id, result: "verified" }), "DESERET_FORBIDDEN");
    await rejectsCode(() => command(MAKER, "handover.verify", { handoverId: id, result: "missing", notes: " " }), "DESERET_INVALID");
    const workspace = await command(MAKER, "handover.verify", { handoverId: id, result: "missing", notes: "Project file absent; rebuilding scenes 3-5." });
    assert.deepEqual(workspace.handovers?.map(item => [item.verification, item.notes]), [["missing", "Project file absent; rebuilding scenes 3-5."]]);
    assert.ok(!workspace.actions.includes("handover.verify"));
    await rejectsCode(() => command(MAKER, "handover.verify", { handoverId: id, result: "verified" }), "DESERET_FORBIDDEN");
    h.db.sqlite.prepare("UPDATE language_projects SET editor_email=? WHERE id='task-1'").run(OTHER_MAKER);
    const reassigned = await handOver("batch", "2026-11-20T08:50:00.000Z", "handover-later");
    h.db.sqlite.prepare("UPDATE deseret_task_handovers SET to_editor_email=? WHERE handover_id=?").run(MAKER, reassigned);
    // MAKER no longer holds any task in the project: project access itself is refused.
    await rejectsCode(() => command(MAKER, "handover.verify", { handoverId: reassigned, result: "verified" }), "FORBIDDEN");
  });

  it("rechecks a pending staffing handover at commit independently of archive history", async () => {
    const guard = await publicationHandoverGuard(h.db, ["task-1"]);
    const holds = () => (h.db.sqlite.prepare(`SELECT ${guard.sql} AS ok`).get(...guard.values) as { ok: number }).ok;
    assert.equal(holds(), 1);
    h.db.sqlite.prepare("INSERT INTO handover_records (id,language_project_id,status) VALUES ('another','task-1','pending')").run();
    assert.equal(holds(), 0);
  });

  it("accepts older clients' source fields even when the archive no longer exists", async () => {
    const id = await handOver("emergency");
    await command(MAKER, "handover.verify", { handoverId: id, result: "missing", notes: "Old source missing" });
    await command(LEAD, "package.publish", { phase: "storyboard", sources: { "scene-a": { archiveId: "obsolete" } } });
    assert.equal(h.state().stage, "storyboard_review");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Item 6: a planned handover that stands in an archive for the daily report records exactly that archive, and the
// write transaction re-checks it; it never checks archive A and stores archive B or nothing.
describe("planned handover with an archive in place of a daily report", () => {
  const FORMER = "former@example.test";
  beforeEach(setupRound);
  const holds = (guard: { sql: string; values: (string | number | null)[] }) => (h.db.sqlite.prepare(`SELECT ${guard.sql} AS ok`).get(...guard.values) as { ok: number }).ok;

  it("records the named archive even when a newer one exists, and fails the transaction once it is no longer valid", async () => {
    await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: `eng-${SECRET}-1` });
    const chosen = archiveOf("task-1")!.id;
    version(h, "eng-newer", "task-1", "03.project");
    await command(MAKER, "archive.register", { taskId: "task-1", projectVersionId: "eng-newer" });
    const recorded = await deseretHandoverStatements(h.db, { handoverId: "h-planned", projectId: PROJECT, taskId: "task-1", kind: "planned", fromEmail: FORMER, toEmail: MAKER, now: "2026-11-20T08:00:00.000Z", archiveId: chosen });
    assert.equal(holds(recorded.guard), 1);
    for (const statement of recorded.statements) await statement.run();
    assert.equal((h.db.sqlite.prepare("SELECT archive_id FROM deseret_task_handovers WHERE handover_id='h-planned'").get() as { archive_id: string }).archive_id, chosen);
    h.db.sqlite.prepare("UPDATE project_files SET deleted_at='2026-11-21' WHERE id=?").run(`eng-${SECRET}-1`);
    assert.equal(holds(recorded.guard), 0, "the archive checked is the archive written, and it must still be valid");
  });

  it("refuses a named archive that is not a valid archive of the task", async () => {
    await command(LEAD, "archive.register", { taskId: "task-2", projectVersionId: `eng-${SECRET}-2` });
    await assert.rejects(() => deseretHandoverStatements(h.db, { handoverId: "h-x", projectId: PROJECT, taskId: "task-1", kind: "planned", fromEmail: FORMER, toEmail: MAKER, now: "2026-11-20T08:00:00.000Z", archiveId: archiveOf("task-2")!.id }),
      (error: unknown) => error instanceof PublicError && error.code === "DESERET_ARCHIVE_INVALID");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Item 5: a Deseret batch editor change hands over the outgoing editor's own valid checkpoint only, re-checked in the
// transaction. Other people's reports are never selected or frozen; ordinary projects and reviewer changes keep theirs.
describe("batch editor change checkpoint", () => {
  const FORMER = "former@example.test";
  beforeEach(setupRound);
  const checkpoint = (id: string, task: string, editor: string, number: number, status = "ready") =>
    h.db.sqlite.prepare("INSERT INTO production_checkpoints (id,language_project_id,editor_email,status,version_number,completeness_status,updated_at) VALUES (?,?,?,?,?,'complete','2026-11-20T00:00:00.000Z')").run(id, task, editor, status, number);
  const holds = (guard: { sql: string; values: (string | number | null)[] }) => (h.db.sqlite.prepare(`SELECT ${guard.sql} AS ok`).get(...guard.values) as { ok: number }).ok;

  it("on a Deseret project takes the outgoing editor's latest valid checkpoint, never someone else's newer one", async () => {
    checkpoint("cp-former", "task-1", FORMER, 1);
    checkpoint("cp-former-invalid", "task-1", FORMER, 2, "invalidated");
    checkpoint("cp-other", "task-1", "someone-else@example.test", 3);
    const picked = await batchHandoverCheckpoint(h.db, { projectId: PROJECT, taskId: "task-1", fromEmail: FORMER, role: "editor" });
    assert.equal(picked.checkpoint?.id, "cp-former");
    assert.equal(holds(picked.guard), 1);
    h.db.sqlite.prepare("UPDATE production_checkpoints SET status='invalidated' WHERE id='cp-former'").run();
    assert.equal(holds(picked.guard), 0, "re-checked in the transaction");
  });

  it("records no checkpoint when the outgoing editor has none, and fails if one appears before commit", async () => {
    checkpoint("cp-other", "task-1", "someone-else@example.test", 3);
    const picked = await batchHandoverCheckpoint(h.db, { projectId: PROJECT, taskId: "task-1", fromEmail: FORMER, role: "editor" });
    assert.equal(picked.checkpoint, null);
    assert.equal(holds(picked.guard), 1);
    checkpoint("cp-late", "task-1", FORMER, 4);
    assert.equal(holds(picked.guard), 0);
  });

  it("keeps the existing rule for ordinary projects and for reviewer changes", async () => {
    checkpoint("cp-former", "task-1", FORMER, 1);
    checkpoint("cp-other", "task-1", "someone-else@example.test", 3);
    const reviewer = await batchHandoverCheckpoint(h.db, { projectId: PROJECT, taskId: "task-1", fromEmail: QC, role: "reviewer" });
    assert.deepEqual([reviewer.checkpoint?.id, holds(reviewer.guard)], ["cp-other", 1]);
    h.db.sqlite.prepare("DELETE FROM deseret_project_links").run();
    const ordinary = await batchHandoverCheckpoint(h.db, { projectId: PROJECT, taskId: "task-1", fromEmail: FORMER, role: "editor" });
    assert.deepEqual([ordinary.checkpoint?.id, holds(ordinary.guard)], ["cp-other", 1]);
  });
});
