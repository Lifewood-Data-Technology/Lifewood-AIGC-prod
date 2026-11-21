// Deseret scenes are submitted with a video and a duration only. No server entry may require, clear or invent a scene
// script: not the integration panel's `scene.save`, not the native production submission, and not the note rule
// of a storyboard submission. A script already stored (historical scenes, published packages) stays in AIGC's
// state: an omitted or blank script carries it forward. An older client that still sends a script keeps the
// original semantics: a changed text is a new scene version, an identical resend is not. Identity, media,
// permission and version rules are unchanged.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { deseretSceneSubmission } from "../db/deseret-scene-submission";
import { submissionNoteRequired } from "../lib/deseret-editor-stage";
import { productionWorkspaceError } from "../lib/production-workspace-errors";
import type { DeseretIntegrationState, DeseretReviewPackage, DeseretScene } from "../lib/deseret-workspace";
import { PublicError } from "../lib/security-controls";
import { createHarness, finalReviewState, LEAD, MAKER, OTHER_MAKER, PROJECT, type Harness, type Row } from "./support/deseret-harness";

const HISTORICAL_SCRIPT = "Historical scene script kept inside AIGC.";
const historical: DeseretScene = { id: "scene-1", order: 1, version: 1, duration: 30, script: HISTORICAL_SCRIPT, characterIds: [], voiceId: "", fileVersionId: "file-scene-v1", languageTaskId: "task-1" };

function productionState(scenes: DeseretScene[] = [historical]): DeseretIntegrationState {
  return { ...finalReviewState(), stage: "production", packages: [], scenes: structuredClone(scenes), revisionSceneIds: [], revision: 3 };
}
let h: Harness;
let request = 0;
const nativeVideo = (id: string, status = "pending_qc", taskId = "task-1") =>
  h.addNative({ id, taskId, directory: "03_项目制作", status, name: `${id}.mp4`, mimeType: "video/mp4", size: 4096, sha256: "c".repeat(64), qualityApproved: status !== "pending_qc" });
function setup(initial: DeseretIntegrationState) {
  h = createHarness(initial);
  request = 0;
  h.db.sqlite.prepare("UPDATE language_projects SET status='制作中' WHERE project_id=?").run(PROJECT);
  nativeVideo("file-scene-v1", "qc_approved");
  nativeVideo("file-scene-v2");
  nativeVideo("file-new-scene");
}
const command = async (email: string, action: string, payload: Row) =>
  h.service.command(email, PROJECT, { requestId: `req-${++request}`, expectedRevision: h.state().revision, action, payload });
const saveScene = (scene: Row, email = MAKER) => command(email, "scene.save", { scene: { order: 1, characterIds: [], voiceId: "", version: 1, ...scene } });
const scene = (id: string) => h.state().scenes.find(item => item.id === id);
const rejectsCode = async (run: () => Promise<unknown>, code: string) =>
  h.rejectsUnchanged(run, code);

describe("Integration panel scene.save: video and duration only", () => {
  beforeEach(() => setup(productionState()));

  it("registers a new scene without a script key", async () => {
    await saveScene({ id: "scene-new", order: 2, duration: 12.5, fileVersionId: "file-new-scene", languageTaskId: "task-1" });
    const saved = scene("scene-new")!;
    assert.equal(Object.hasOwn(saved, "script"), false, JSON.stringify(saved));
    assert.deepEqual({ ...saved }, { id: "scene-new", order: 2, version: 1, duration: 12.5, characterIds: [], voiceId: "", fileVersionId: "file-new-scene", languageTaskId: "task-1" });
  });

  it("keeps a historical script when a scene is edited without one, and bumps the version only for a real change", async () => {
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1" });
    assert.deepEqual(scene("scene-1"), historical, "resaving the unchanged scene keeps its version and script");
    await saveScene({ id: "scene-1", duration: 31, fileVersionId: "file-scene-v2" });
    assert.deepEqual(scene("scene-1"), { ...historical, version: 2, duration: 31, fileVersionId: "file-scene-v2" });
  });

  it("keeps an older client's script semantics: blank carries the text, a changed text is a new version, a resend is not", async () => {
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1", script: "   " });
    assert.deepEqual(scene("scene-1"), historical, "a blank script neither fails nor clears the stored one");
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1", script: HISTORICAL_SCRIPT });
    assert.deepEqual(scene("scene-1"), historical, "the identical text is not a change");
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1", script: "Older client text" });
    assert.deepEqual(scene("scene-1"), { ...historical, version: 2, script: "Older client text" }, "a changed text never overwrites the same version");
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1", script: "Older client text", version: 2 });
    assert.equal(scene("scene-1")!.version, 2, "an identical resend keeps the version");
  });

  it("keeps the exact bytes of a legacy script with surrounding spaces, and its identical resend is not a new version", async () => {
    const padded = "  Legacy text saved as sent  ";
    setup(productionState([{ ...historical, script: padded }]));
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1", script: padded });
    assert.deepEqual(scene("scene-1"), { ...historical, script: padded });
    await saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1" });
    assert.deepEqual(scene("scene-1"), { ...historical, script: padded }, "omitting the script keeps the stored bytes");
  });

  it("still rejects a malformed script field, an invalid duration, a non-video and another maker's task", async () => {
    await rejectsCode(() => saveScene({ id: "scene-new", order: 2, duration: 10, fileVersionId: "file-new-scene", script: 42 }), "DESERET_INVALID");
    await rejectsCode(() => saveScene({ id: "scene-new", order: 2, duration: 10, fileVersionId: "file-new-scene", script: "x".repeat(20001) }), "DESERET_INVALID");
    for (const duration of [0, -1, 3601, "10"]) await rejectsCode(() => saveScene({ id: "scene-new", order: 2, duration, fileVersionId: "file-new-scene" }), "DESERET_INVALID");
    h.addNative({ id: "file-image", taskId: "task-1", directory: "03_项目制作", status: "pending_qc", name: "still.png", mimeType: "image/png", size: 10, sha256: "d".repeat(64) });
    await rejectsCode(() => saveScene({ id: "scene-new", order: 2, duration: 10, fileVersionId: "file-image" }), "DESERET_INVALID");
    nativeVideo("file-other-task", "pending_qc", "task-2");
    await rejectsCode(() => saveScene({ id: "scene-new", order: 2, duration: 10, fileVersionId: "file-other-task" }), "DESERET_INVALID");
    await rejectsCode(() => saveScene({ id: "scene-new", order: 2, duration: 10, fileVersionId: "file-new-scene" }, OTHER_MAKER), "DESERET_INVALID");
  });

  it("still requires a new video version for a requested scene revision", async () => {
    setup({ ...productionState(), revisionSceneIds: ["scene-1"] });
    await rejectsCode(() => saveScene({ id: "scene-1", duration: 45, fileVersionId: "file-scene-v1" }), "DESERET_NEW_VERSION_REQUIRED");
    await rejectsCode(() => saveScene({ id: "scene-1", duration: 30, fileVersionId: "file-scene-v1", script: "Rewritten by an older client" }), "DESERET_NEW_VERSION_REQUIRED");
    await saveScene({ id: "scene-1", duration: 45, fileVersionId: "file-scene-v2" });
    assert.deepEqual(scene("scene-1"), { ...historical, version: 2, duration: 45, fileVersionId: "file-scene-v2" });
  });
});

describe("Native production submission of a scene", () => {
  beforeEach(() => setup(productionState()));
  const submit = async (input: Row | string | undefined, fileVersionId = "file-new-scene", replaces?: string) => {
    const result = await deseretSceneSubmission(h.db, PROJECT, "task-1", fileVersionId, typeof input === "object" ? JSON.stringify(input) : input, replaces);
    for (const statement of result.statements) await statement.run();
    return result;
  };
  const rejects = (run: () => Promise<unknown>, code: string, message?: RegExp) => assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof PublicError, String(error));
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    assert.doesNotMatch(error.message, /script/i, "no error asks for a script");
    return true;
  });

  it("registers a new scene from video and duration only", async () => {
    const result = await submit({ id: "scene-new", version: 0, duration: 8 });
    assert.equal(result.storyboard, true);
    assert.deepEqual({ ...scene("scene-new") }, { id: "scene-new", order: 2, version: 1, duration: 8, characterIds: [], voiceId: "", fileVersionId: "file-new-scene", languageTaskId: "task-1" });
  });

  it("replays an older client's request that still carries a script, blank or not", async () => {
    await submit({ id: "scene-blank", version: 0, script: "", duration: 8 });
    assert.equal(Object.hasOwn(scene("scene-blank")!, "script"), false);
    await submit({ id: "scene-text", version: 0, script: "  Old draft text  ", duration: 9 }, "file-scene-v2");
    assert.equal(scene("scene-text")!.script, "Old draft text");
  });

  it("keeps the historical script of an edited or returned scene; only a real change is a new version", async () => {
    await submit({ id: "scene-1", version: 1, duration: 30 }, "file-scene-v1");
    assert.deepEqual(scene("scene-1"), historical);
    await submit({ id: "scene-1", version: 1, script: "Changed by an older client", duration: 30 }, "file-scene-v1");
    assert.deepEqual(scene("scene-1"), { ...historical, version: 2, script: "Changed by an older client" }, "a changed text never overwrites the same version");
    await submit({ id: "scene-1", version: 2, duration: 30 }, "file-scene-v2");
    assert.deepEqual(scene("scene-1"), { ...historical, version: 3, script: "Changed by an older client", fileVersionId: "file-scene-v2" });
  });

  it("still requires a new video for a returned scene, whatever the script", async () => {
    setup({ ...productionState(), revisionSceneIds: ["scene-1"] });
    await rejects(() => submit({ id: "scene-1", version: 1, duration: 30 }, "file-scene-v1"), "DESERET_NEW_VERSION_REQUIRED");
    await rejects(() => submit({ id: "scene-1", version: 1, script: "Rewritten", duration: 30 }, "file-scene-v1"), "DESERET_NEW_VERSION_REQUIRED");
    await submit({ id: "scene-1", version: 1, duration: 30 }, "file-scene-v2");
    assert.deepEqual(scene("scene-1"), { ...historical, version: 2, fileVersionId: "file-scene-v2" });
  });

  it("submits an already registered scene video without a script and still requires a registered scene", async () => {
    const stored = productionState([{ ...historical, script: undefined as unknown as string }]);
    delete (stored.scenes[0] as Partial<DeseretScene>).script;
    setup(stored);
    assert.equal((await submit(undefined, "file-scene-v1")).storyboard, true);
    await rejects(() => submit(undefined, "file-new-scene"), "DESERET_SCENE_REQUIRED", /duration/i);
  });

  it("keeps duration, identity, version, task scope and replacement checks", async () => {
    for (const bad of [{ id: "scene-new", version: 0 }, { id: "scene-new", version: 0, duration: 0 }, { id: "scene-new", version: 0, duration: 3601 },
      { id: "bad id", version: 0, duration: 5 }, { id: "scene-new", version: 0, duration: 5, script: 7 }, { id: "scene-new", version: 0, duration: 5, script: "x".repeat(20001) }])
      await rejects(() => submit(bad), "DESERET_SCENE_INVALID", /duration/i);
    await rejects(() => submit("{"), "DESERET_SCENE_INVALID");
    await rejects(() => submit({ id: "scene-1", version: 0, duration: 5 }), "DESERET_CONFLICT");
    await rejects(() => submit({ id: "scene-new", version: 0, duration: 5 }, "file-new-scene", "file-scene-v1"), "DESERET_SCENE_REPLACEMENT");
  });

  it("maps the duration errors to an accurate Chinese message", () => {
    for (const message of ["Check the scene duration.", "Register the scene video and duration before submitting for review.", "Check the scene script and duration."]) {
      const zh = productionWorkspaceError(message, "zh");
      assert.match(zh, /时长/);
      assert.doesNotMatch(zh, /脚本/, `${message} → ${zh}`);
    }
  });
});

describe("Submission note rule", () => {
  it("needs no note for a Deseret storyboard scene that does not replace a pending video", () => {
    assert.equal(submissionNoteRequired({ mode: "final", storyboard: true, replacing: false }), false);
    assert.equal(submissionNoteRequired({ mode: "final", storyboard: true, replacing: true }), true, "a replacement still needs its reason");
    assert.equal(submissionNoteRequired({ mode: "final", storyboard: false, replacing: false }), true, "finals and ordinary tasks keep their note");
    for (const mode of ["checkpoint", "daily"]) assert.equal(submissionNoteRequired({ mode, storyboard: true, replacing: false }), true);
    assert.equal(submissionNoteRequired({ mode: "materials", storyboard: false, replacing: false }), false);
  });

  // The server passes the in-transaction scene registration's `storyboard` to the rule. That result comes from the
  // stored stage and is guarded by the stored link revision, so a stage change before commit fails the write.
  it("takes storyboard from the stage-guarded scene registration of the same submission", async () => {
    setup(productionState());
    const sceneRound = await deseretSceneSubmission(h.db, PROJECT, "task-1", "file-new-scene", JSON.stringify({ id: "scene-new", version: 0, duration: 5 }));
    assert.equal(sceneRound.storyboard, true);
    assert.deepEqual([sceneRound.sql, sceneRound.values], ["EXISTS(SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)", [PROJECT, 3]]);
    assert.equal(submissionNoteRequired({ mode: "final", storyboard: sceneRound.storyboard, replacing: false }), false);
    const ordinary = await deseretSceneSubmission(h.db, "native-only-project", "task-x", "file-x");
    assert.equal(ordinary.storyboard, false, "ordinary tasks keep their note");
    assert.equal(submissionNoteRequired({ mode: "final", storyboard: ordinary.storyboard, replacing: false }), true);
    h.db.sqlite.prepare("UPDATE deseret_project_links SET state_json=json_set(state_json,'$.stage','final_production')").run();
    const finalRound = await deseretSceneSubmission(h.db, PROJECT, "task-1", "file-final");
    assert.equal(finalRound.storyboard, false, "the assembled final keeps its note");
    assert.equal(submissionNoteRequired({ mode: "final", storyboard: finalRound.storyboard, replacing: false }), true);
  });
});

describe("Publication keeps historical scripts internal and never invents one", () => {
  const approvedStoryboard = (scenes: DeseretScene[]): DeseretReviewPackage => ({ id: "pkg-sb", phase: "storyboard", version: 1, publicationId: "pub-sb", publishedAt: "2026-11-19T00:00:00.000Z",
    filesReady: true, conclusion: "approved", scenes: structuredClone(scenes), files: [] });
  const sceneA: DeseretScene = { id: "scene-a", order: 2, version: 1, duration: 10, characterIds: [], voiceId: "", fileVersionId: "file-scene-a", languageTaskId: "task-1" } as DeseretScene;
  delete (sceneA as Partial<DeseretScene>).script;
  function finalProduction(scenes: DeseretScene[]) {
    setup({ ...productionState(scenes), stage: "final_production", packages: [approvedStoryboard(scenes)] });
    nativeVideo("file-scene-a", "qc_approved");
    nativeVideo("file-final", "final");
    h.db.sqlite.prepare("INSERT INTO production_final_submissions VALUES ('sub-final','file-final','task-1',?)").run(MAKER);
    h.db.sqlite.prepare("INSERT INTO production_submission_receipts VALUES ('sub-final',?,?)").run(MAKER, JSON.stringify({ deseretPhase: "final", finalVersionId: "file-final" }));
  }
  const publishedFinal = () => h.state().packages.at(-1)!.scenes[0];
  /** Publication pins an internal archive to every scene (see deseret-production-archive.test.ts); register one for task-1. */
  async function publishWithArchive(payload: Row, sceneIds: string[]) {
    h.db.sqlite.prepare("INSERT OR IGNORE INTO aigc_folders (id,parent_folder_id,language_project_id,folder_code,deleted_at) VALUES ('folder-task-1-project','folder-task-1-03','task-1','03.project',NULL)").run();
    h.addNative({ id: "file-engineering", taskId: "task-1", directory: "03_项目制作", status: "available", name: "trailer.prproj", mimeType: "application/octet-stream", size: 10, sha256: "f".repeat(64) });
    h.db.sqlite.prepare("UPDATE aigc_files SET folder_id='folder-task-1-project' WHERE id='logical-file-engineering'").run();
    await command(LEAD, "archive.register", { taskId: "task-1", projectVersionId: "file-engineering" });
    const archive = String((h.db.sqlite.prepare("SELECT id FROM deseret_production_archives ORDER BY archive_number DESC").get() as Row).id);
    // Explicit confirmation of each scene's current version and video; a final scene is the published final file.
    const state = h.state();
    const confirm = (id: string) => { const scene = state.scenes.find(item => item.id === id);
      return scene ? { archiveId: archive, sceneVersion: scene.version, videoVersionId: scene.fileVersionId }
        : { archiveId: archive, sceneVersion: 1 + state.packages.filter(pack => pack.phase === "final" && pack.files.some(file => file.languageTaskId === "task-1")).length, videoVersionId: String(payload.fileVersionId) }; };
    return command(LEAD, "package.publish", { ...payload, sources: Object.fromEntries(sceneIds.map(id => [id, confirm(id)])) });
  }

  it("publishes a storyboard of scenes without scripts and keeps historical text in the package", async () => {
    setup(productionState([historical, sceneA]));
    nativeVideo("file-scene-a", "qc_approved");
    await publishWithArchive({ phase: "storyboard" }, ["scene-1", "scene-a"]);
    const [old, fresh] = h.state().packages.at(-1)!.scenes;
    assert.equal(old.script, HISTORICAL_SCRIPT);
    assert.equal(Object.hasOwn(fresh, "script"), false);
  });

  it("joins only the stored scripts into the final scene, and adds none when no scene has one", async () => {
    finalProduction([historical, sceneA]);
    await publishWithArchive({ phase: "final", fileVersionId: "file-final", duration: 40 }, ["final-task-1"]);
    assert.equal(publishedFinal().script, HISTORICAL_SCRIPT);
    const padded = { ...historical, id: "scene-2", order: 3, script: "  Second legacy text  " };
    finalProduction([historical, sceneA, padded, { ...sceneA, id: "scene-blank", order: 4, script: "   " }]);
    await publishWithArchive({ phase: "final", fileVersionId: "file-final", duration: 40 }, ["final-task-1"]);
    assert.equal(publishedFinal().script, `${HISTORICAL_SCRIPT}

  Second legacy text  `, "stored texts are joined byte for byte; blank ones are skipped");
    finalProduction([sceneA]);
    await publishWithArchive({ phase: "final", fileVersionId: "file-final", duration: 40 }, ["final-task-1"]);
    assert.equal(Object.hasOwn(publishedFinal(), "script"), false, JSON.stringify(publishedFinal()));
  });
});
