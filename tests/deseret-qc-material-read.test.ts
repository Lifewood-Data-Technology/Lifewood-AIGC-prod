// P2 regression: an assigned quality reviewer could not open Deseret attachments registered in the task's
// `02_客户素材` folder. The integration read query did not project `directory`, so only the review-status rule
// applied and the workspace never handed out the registered version id, although /api/files allows the read.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeIntegrationFiles } from "../db/deseret-native-files";
import { qualityFileVisible } from "../lib/task-file-access";
import { concludedEnvelope, createHarness, feedbackEnvelope, FOREIGN_QC, guidanceImage, LEAD, MAKER, OTHER_PROJECT, OTHER_QC, PROJECT, QC, type Harness, type Row } from "./support/deseret-harness";
import { PublicError } from "../lib/security-controls";

let h: Harness;
const handoff = guidanceImage(10, { purpose: "reference", name: "cover.png", objectKey: "aigc-guidance/db-project-1/cover.png" });
const attachment = guidanceImage(11, { name: "reference-note.png" });
const frameImage = guidanceImage(12, { name: "frame-12.png" });

async function receiveAll() {
  h.addHandoffMaterial(handoff);
  const [note, noteRaw] = feedbackEnvelope("evt-note", [attachment] as never, { sceneId: "final-task-1" });
  await h.service.receive(note, noteRaw);
  const [concluded, raw] = concludedEnvelope({ actorId: "qa-reviewer-7", body: "Fix the title.", sceneId: "final-task-1",
    issues: [{ id: "iss-1", role: "publisher_qa", actorId: "qa-reviewer-7", sceneId: "final-task-1", sceneVersion: 1, body: "Title hidden", seconds: 4, frames: [{ seconds: 4, file: frameImage }] }] });
  await h.service.receive(concluded, raw);
}
/** The worker registered the shared materials in both tasks and the frame only in task-1, in 02_客户素材. */
function registerAll() {
  for (const taskId of ["task-1", "task-2"]) {
    h.transferReady(handoff, null, taskId, `native-cover-${taskId}`);
    h.transferReady(attachment, "pkg-final-1", taskId, `native-note-${taskId}`);
  }
  h.transferReady(frameImage, "pkg-final-1", "task-1", "native-frame-task-1");
}
async function readable(email: string) {
  const workspace = await h.service.workspace(email, PROJECT);
  return {
    handoff: workspace.materialManifest.find(item => item.id === handoff.id)?.nativeVersionId ?? null,
    attachment: workspace.feedback.find(note => note.id === "evt-note")?.files?.[0]?.nativeVersionId ?? null,
    frame: workspace.feedback.find(note => note.id === "iss-1")?.frames?.[0]?.file.nativeVersionId ?? null,
    candidates: workspace.fileCandidates.map(file => file.id).sort(),
  };
}

describe("Assigned QC reads registered handoff materials and review attachments (P2, no revision frames)", () => {
  it("hands the assigned QC the 02_客户素材 copies and nothing from another task", async () => {
    h = createHarness();
    h.addHandoffMaterial(handoff);
    const [note, noteRaw] = feedbackEnvelope("evt-note", [attachment] as never, { sceneId: "final-task-1" });
    await h.service.receive(note, noteRaw);
    h.transferReady(handoff, null, "task-1", "native-cover-task-1");
    h.transferReady(attachment, "pkg-final-1", "task-1", "native-note-task-1");
    const qc = await h.service.workspace(QC, PROJECT);
    assert.equal(qc.materialManifest.find(item => item.id === handoff.id)?.nativeVersionId, "native-cover-task-1");
    assert.equal(qc.feedback.find(item => item.id === "evt-note")?.files?.[0]?.nativeVersionId, "native-note-task-1");
    const other = await h.service.workspace(OTHER_QC, PROJECT);
    assert.equal(other.materialManifest.find(item => item.id === handoff.id)?.nativeVersionId, undefined);
  });
});

describe("Assigned QC reads registered 02_客户素材 attachments (P2)", () => {
  beforeEach(async () => {
    h = createHarness();
    await receiveAll();
    registerAll();
  });

  it("hands the assigned QC reviewer the registered copies in their own task", async () => {
    const view = await readable(QC);
    assert.deepEqual([view.handoff, view.attachment, view.frame], ["native-cover-task-1", "native-note-task-1", "native-frame-task-1"]);
  });

  it("keeps review candidates on the review-status rule: 02 copies are not offered as QC review files", async () => {
    const view = await readable(QC);
    assert.equal(view.candidates.some(id => id.startsWith("native-")), false);
  });

  it("resolves the other task's QC only to copies in their own task, never task-1's", async () => {
    const view = await readable(OTHER_QC);
    assert.equal(view.handoff, "native-cover-task-2");
    assert.equal(view.attachment, null, "the attachment's scene belongs to task-1, so the note is not visible");
    assert.equal(view.frame, null);
    const direct = await nativeIntegrationFiles(h.context("quality", OTHER_QC), ["native-cover-task-1", "native-note-task-1", "native-frame-task-1"], { incomingMaterials: true });
    assert.deepEqual(direct, []);
  });

  it("keeps the lead and the maker unchanged", async () => {
    assert.deepEqual((await readable(LEAD)).frame, "native-frame-task-1");
    const maker = await readable(MAKER);
    assert.deepEqual([maker.handoff, maker.attachment, maker.frame], ["native-cover-task-1", "native-note-task-1", "native-frame-task-1"]);
  });

  it("denies a reviewer of another project, both the workspace and the read query", async () => {
    await assert.rejects(() => h.service.workspace(FOREIGN_QC, PROJECT), (error: unknown) => error instanceof PublicError && error.status === 403);
    const own = await nativeIntegrationFiles(h.context("quality", FOREIGN_QC, OTHER_PROJECT), ["native-cover-task-1", "native-frame-task-1"], { incomingMaterials: true });
    assert.deepEqual(own, []);
  });

  it("denies a copy that sits outside the reviewer folders, as /api/files does", async () => {
    h.addNative({ id: "native-draft", taskId: "task-1", directory: "03_项目制作", status: "available", name: "draft.png", mimeType: "image/png", size: 10, sha256: "f".repeat(64) });
    const files = await nativeIntegrationFiles(h.context("quality", QC), ["native-draft", "native-cover-task-1"], { incomingMaterials: true });
    assert.deepEqual(files.map(file => file.id), ["native-cover-task-1"]);
  });

  it("applies exactly the read endpoint's rule over the stored row (status, source, directory)", async () => {
    for (const [directory, status] of [["02_客户素材", "available"], ["01_项目资料", "available"], ["04_质检", "available"], ["03_项目制作", "available"], ["03_项目制作", "pending_qc"]]) {
      const id = `native-${directory}-${status}`;
      h.addNative({ id, taskId: "task-1", directory, status, name: `${id}.png`, mimeType: "image/png", size: 10, sha256: "e".repeat(64) });
      const row = h.db.sqlite.prepare("SELECT * FROM project_files WHERE id=?").get(id) as Row;
      const returned = (await nativeIntegrationFiles(h.context("quality", QC), [id], { incomingMaterials: true })).length === 1;
      assert.equal(returned, qualityFileVisible(row), `${directory} ${status}`);
    }
  });

  it("returns nothing in material mode without explicit ids", async () => {
    assert.deepEqual(await nativeIntegrationFiles(h.context("quality", QC), undefined, { incomingMaterials: true }), []);
  });

  it("does not hand out copies before the transfer is ready", async () => {
    h = createHarness();
    await receiveAll();
    const view = await readable(QC);
    assert.deepEqual([view.handoff, view.attachment, view.frame], [null, null, null]);
  });
});
