import type { DatabaseStatement } from "../db/database";
import assert from "node:assert/strict";
import test from "node:test";
import { changeStoryboardDrafts } from "../db/deseret-storyboard-drafts";
import { createHarness, finalReviewState, MAKER, PROJECT, QC } from "./support/deseret-harness";

function setup() {
  const h = createHarness({ ...finalReviewState(), scenes: [], stage: "production", packages: [], revisionSceneIds: [] });
  const sql = h.db.sqlite;
  sql.exec(`
    ALTER TABLE aigc_files ADD display_name TEXT;
    ALTER TABLE aigc_files ADD created_by TEXT;
    ALTER TABLE aigc_files ADD created_at TEXT;
    ALTER TABLE aigc_files ADD updated_at TEXT;
    ALTER TABLE aigc_file_versions ADD mime_type TEXT;
    ALTER TABLE aigc_file_versions ADD db_file_name TEXT;
    ALTER TABLE aigc_storage_objects ADD provider TEXT;
    ALTER TABLE aigc_storage_objects ADD storage_class TEXT;
    ALTER TABLE aigc_storage_objects ADD created_at TEXT;
    ALTER TABLE production_final_submissions ADD submitted_at TEXT;
    ALTER TABLE production_final_submissions ADD notes TEXT;
    ALTER TABLE production_submission_receipts ADD payload_hash TEXT;
    ALTER TABLE production_submission_receipts ADD created_at TEXT;
    CREATE TABLE accounts(email TEXT PRIMARY KEY,access_group TEXT,status TEXT);
    CREATE TABLE production_staged_files(id TEXT PRIMARY KEY,actor_email TEXT,language_project_id TEXT,purpose TEXT,category TEXT,file_kind TEXT,state TEXT,expires_at TEXT,updated_at TEXT,committed_version_id TEXT,committed_submission_id TEXT,original_name TEXT,object_key TEXT,size_bytes INTEGER,mime_type TEXT,checksum_sha256 TEXT);
    CREATE TABLE notifications(id TEXT PRIMARY KEY,recipient_email TEXT,type TEXT,title_zh TEXT,title_en TEXT,body_zh TEXT,body_en TEXT,target_type TEXT,target_id TEXT,is_read INTEGER,created_at TEXT,actor_email TEXT,actor_name TEXT,actor_role TEXT,event_action TEXT);
    INSERT INTO aigc_folders(id,parent_folder_id,language_project_id,folder_code) VALUES('preview-folder','folder-task-1-03','task-1','03.preview'),('render-folder','folder-task-1-03','task-1','03.render.video');
    UPDATE language_projects SET status='制作中' WHERE id='task-1';
  `);
  sql.prepare("INSERT INTO accounts VALUES(?,'quality','active')").run(QC);
  function staged(id: string, checksum = id, category = "video", owner = MAKER) {
    sql.prepare("INSERT INTO production_staged_files(id,actor_email,language_project_id,purpose,category,file_kind,state,expires_at,original_name,object_key,size_bytes,mime_type,checksum_sha256) VALUES(?,?,'task-1',?,?,'video','ready','2099-01-01',?,?,12,'video/mp4',?)")
      .run(id, owner, category === "final" ? "final" : "materials", category, `${id}.mp4`, id, checksum);
  }
  function run(kind: string, fields: Record<string, string> = {}, expected = rev(), submissionId = crypto.randomUUID()) {
    return changeStoryboardDrafts({
      db: h.db, taskId: "task-1", projectId: PROJECT, email: MAKER, actorName: "Editor", reviewer: QC, taskLabel: "Book · English", revision: rev(),
      guard: { sql: "EXISTS(SELECT 1 FROM language_projects WHERE id='task-1' AND editor_email=? AND revision=? AND status IN ('制作中','质检驳回'))", values: [MAKER, expected] },
      head: async () => ({ size: 12, etag: "etag" }), summary: h.db.prepare("UPDATE projects SET name=name WHERE 0"),
    }, { languageProjectId: "task-1", submissionId, expectedRevision: String(expected), kind, ...fields }, `hash-${submissionId}`);
  }
  function rev() { return Number(sql.prepare("SELECT revision FROM language_projects WHERE id='task-1'").get()!.revision); }
  const save = (sceneId: string, fileVersionId: string, sceneVersion = "0") => run("storyboard_draft", { sceneId, fileVersionId, sceneVersion, duration: "3.5" });
  const submit = () => run("storyboard_submit", { materialsConfirmed: "true" });
  return { ...h, sql, run, rev, staged, save, submit };
}

const storage = { WASABI_BUCKET: "test", WASABI_REGION: "test", WASABI_ENDPOINT: "https://example.test" };
function setTestStorage(t: import("node:test").TestContext) {
  const previous = Object.fromEntries(Object.keys(storage).map(key => [key, process.env[key]]));
  Object.assign(process.env, storage);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
test("drafts survive staging expiry, and one confirmation creates one notification and per-scene versions", async t => {
  setTestStorage(t);
  const h = setup();
  for (const [index, id] of ["opening", "middle", "ending"].entries()) {
    h.staged(id, id, index === 0 ? "final" : "video");
    await h.save(`scene-${id}`, id);
    assert.equal(h.state().storyboardDrafts?.length, index + 1);
    assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM notifications").get()!.n, 0);
    assert.equal(h.sql.prepare("SELECT state FROM production_staged_files WHERE id=?").get(id)!.state, "committed");
  }
  h.sql.exec("UPDATE production_staged_files SET expires_at='1999-01-01'");
  await assert.rejects(h.run("storyboard_submit"), /Confirm/);
  await h.submit();
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient_email=?").get(QC)!.n, 1);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM production_final_submissions").get()!.n, 3);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM project_files WHERE status='pending_qc'").get()!.n, 3);
  assert.equal(h.sql.prepare("SELECT status FROM language_projects WHERE id='task-1'").get()!.status, "待质检");
  assert.deepEqual(h.state().scenes.map(s => [s.id, s.order, s.version]), [["scene-opening", 1, 1], ["scene-middle", 2, 1], ["scene-ending", 3, 1]]);
  assert.deepEqual(h.state().storyboardDrafts, []);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM deseret_outbox").get()!.n, 0);

  const [a, b, c] = h.state().scenes;
  h.sql.prepare("UPDATE project_files SET status='qc_approved' WHERE id IN (?,?)").run(a.fileVersionId, c.fileVersionId);
  h.sql.prepare("UPDATE project_files SET status='rejected' WHERE id=?").run(b.fileVersionId);
  h.sql.exec("UPDATE language_projects SET status='质检驳回',revision=revision+1 WHERE id='task-1'");
  h.staged("replacement", "new-content");
  await assert.rejects(h.save(a.id, "replacement", "1"), /returned/);
  await h.save(b.id, "middle", "1");
  await assert.rejects(h.submit(), /revised video/);
  await h.save(b.id, "replacement", "1");
  await h.submit();
  assert.deepEqual(h.state().scenes.filter(s => s.id !== b.id), [a, c]);
  const corrected = h.state().scenes.find(s => s.id === b.id)!;
  assert.equal(corrected.version, 2); assert.equal(corrected.order, 2);
  const oldVersion = h.sql.prepare("SELECT file_id FROM aigc_file_versions WHERE id=?").get(b.fileVersionId)!;
  assert.equal(h.sql.prepare("SELECT file_id FROM aigc_file_versions WHERE id=?").get(corrected.fileVersionId)!.file_id, oldVersion.file_id);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM notifications").get()!.n, 2);
});

test("removing a draft preserves the source; unauthorized, stale or deleted selections leave the batch unchanged", async t => {
  setTestStorage(t);
  const h = setup();
  await assert.rejects(h.submit(), /Confirm/);
  h.staged("foreign", "f", "video", QC);
  await assert.rejects(h.save("a", "foreign"), /no longer available/);
  h.staged("saved");
  const rev = h.rev();
  await h.save("a", "saved");
  await assert.rejects(h.run("storyboard_remove", { sceneId: "a" }, rev), /Refresh/);
  await h.run("storyboard_remove", { sceneId: "a" });
  assert.deepEqual(h.state().storyboardDrafts, []);
  await h.save("b", "saved");
  h.sql.prepare("UPDATE project_files SET deleted_at='now' WHERE id='saved'").run();
  await assert.rejects(h.submit(), /no longer available/);
  assert.equal(h.state().storyboardDrafts?.length, 1);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM notifications").get()!.n, 0);
});

test("a one-scene submission rolls back fully when the reviewer becomes inactive", async t => {
  setTestStorage(t);
  const h = setup();
  h.staged("only");
  await h.save("only", "only");
  h.sql.exec("UPDATE accounts SET status='inactive'");
  await assert.rejects(h.submit(), /Record changed/);
  assert.equal(h.state().storyboardDrafts?.length, 1);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM production_final_submissions").get()!.n, 0);
  h.sql.exec("UPDATE accounts SET status='active'");
  await h.submit();
  assert.equal(h.state().scenes.length, 1);
});
test("a batch can repair one of two returned scenes and keep the other for a later submission", async t => {
  setTestStorage(t);
  const h = setup();
  for (const id of ["s1", "s2"]) { h.staged(id); await h.save(id, id); }
  await h.submit();
  const [first, second] = h.state().scenes;
  h.sql.prepare("UPDATE project_files SET status='rejected' WHERE id IN (?,?)").run(first.fileVersionId, second.fileVersionId);
  h.sql.exec("UPDATE language_projects SET status='质检驳回',revision=revision+1 WHERE id='task-1'");
  h.staged("changed-one"); await h.save("s1", "changed-one", "1"); await h.submit();
  assert.deepEqual(h.state().scenes[1], second);
  const repairedFirst = h.state().scenes[0];
  h.sql.prepare("UPDATE project_files SET status='qc_approved' WHERE id=?").run(repairedFirst.fileVersionId);
  h.sql.exec("UPDATE language_projects SET status='质检驳回',revision=revision+1 WHERE id='task-1'");
  h.staged("changed-two"); await h.save("s2", "changed-two", "1"); await h.submit();
  assert.deepEqual(h.state().scenes[0], repairedFirst);
  assert.equal(h.state().scenes[1].version, 2);
});
test("the existing 200 scene package ceiling holds across drafts, and concurrent identical confirms create one batch", async t => {
  setTestStorage(t);
  const h = setup();
  for (let i = 1; i <= 200; i++) { const id = "s" + i; h.staged(id); await h.save(id, id); }
  h.staged("extra"); await assert.rejects(h.save("extra", "extra"), /200 scenes/);
  const revision = h.rev(), id = crypto.randomUUID();
  const submit = () => h.run("storyboard_submit", { materialsConfirmed: "true" }, revision, id);
  // The in-memory harness has one SQLite connection. Queue its writes as the production
  // serializable transactions would, while letting both confirmations read the same snapshot.
  const transact = h.db.batch.bind(h.db);
  let tail = Promise.resolve();
  h.db.batch = <T>(statements: DatabaseStatement[]) => {
    const transaction = tail.then(() => transact<T>(statements));
    tail = transaction.then(() => { }, () => { });
    return transaction;
  };
  const results = await Promise.all([submit(), submit()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.state().scenes.length, 200);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM notifications").get()!.n, 1);
});
