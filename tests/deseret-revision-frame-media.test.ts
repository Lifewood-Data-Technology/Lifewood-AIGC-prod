// Final QA revision frames may be PNG/JPEG images or MP4/MOV video references, on the unchanged wire
// (`issues[].frames[]` = `{ seconds, caption?, file }`, with the file's kind given only by its MIME type).
// Covers the shared media rule, intake persistence on the real service, the transfer worker's handoff to native
// registration, and the per-account projection. Synthetic data only.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeseretIntegrationJobs } from "../db/deseret-integration-jobs";
import { QA_REVISION_LIMITS } from "../db/deseret-integration";
import { revisionFrameKind } from "../lib/deseret-frame-media";
import type { HandoffMaterial } from "../lib/deseret-integration-contract";
import type { MaterialTransferPlan } from "../runtime/deseret-material-transfer";
import { concludedEnvelope, createHarness, EXTERNAL, feedbackEnvelope, guidanceImage, MAKER, OTHER_MAKER, PROJECT, type Harness, type Row } from "./support/deseret-harness";

const media = (n: number, name: string, mimeType: string, override: Row = {}) =>
  guidanceImage(n, { name, mimeType, objectKey: `aigc-guidance/${EXTERNAL}/guide-${n}-${name}`, ...override });
const png = media(1, "title.png", "image/png");
const jpeg = media(2, "logo.JPG", "image/jpeg");
const mp4 = media(3, "cut.mp4", "video/mp4", { size: QA_REVISION_LIMITS.imageBytes });
const mov = media(4, "grade.mov", "video/quicktime");
const frame = (file: Row, seconds = 4, caption?: string) => ({ seconds, file, ...(caption === undefined ? {} : { caption }) });
const issue = (id: string, frames: unknown[], sceneId = "final-task-1"): Row => ({ id, role: "creative", actorId: "cr-2", sceneId, sceneVersion: 1, body: `Reason ${id}`, seconds: 2, frames });
const summary = (issues: Row[]) => ({ actorId: "qa-reviewer-7", body: "Fix the listed issues.", sceneId: "final-task-1", issues });

describe("Revision frame media rule", () => {
  it("accepts legacy image MIME types and checks MP4 and MOV extensions", () => {
    assert.deepEqual([png, jpeg, mp4, mov].map(file => revisionFrameKind(file)), ["image", "image", "video", "video"]);
    assert.equal(revisionFrameKind({ name: "a.jpeg", mimeType: "image/jpeg" }), "image");
    assert.equal(revisionFrameKind({ name: "A.MOV", mimeType: "video/quicktime" }), "video");
    for (const file of [
      { name: "a.png", mimeType: "video/mp4" }, { name: "a.mov", mimeType: "video/mp4" },
      { name: "a.webp", mimeType: "image/webp" }, { name: "a.webm", mimeType: "video/webm" },
      { name: "a.mp4", mimeType: "Video/MP4" }, { name: "a.mp4", mimeType: "video/mp4; codecs=avc1" }, { name: "mp4", mimeType: "video/mp4" },
      { name: "a.mp4", mimeType: undefined }, { name: "a.png", mimeType: "application/octet-stream" },
    ]) assert.equal(revisionFrameKind(file), null, `${file.name} ${file.mimeType}`);
  });


});

let h: Harness;
const receive = (qaRevision: unknown, eventId = "evt-final-revision") => {
  const [envelope, raw] = concludedEnvelope(qaRevision, eventId);
  return h.service.receive(envelope, raw);
};
const materials = () => (h.db.sqlite.prepare("SELECT file_id,package_id,state,manifest_json FROM deseret_material_tasks ORDER BY file_id").all() as Row[])
  .map(row => [row.file_id, row.package_id, row.state, JSON.parse(String(row.manifest_json))]);

describe("Revision frame media: intake persistence", () => {
  beforeEach(() => { h = createHarness(); });

  it("persists image and video frames exactly as sent, with one transfer task per file", async () => {
    assert.deepEqual(await receive(summary([issue("iss-media", [frame(png, 1, "Title"), frame(jpeg, 2), frame(mp4, 3, "Cut too early"), frame(mov, 4)])])),
      { accepted: true, eventId: "evt-final-revision" });
    const stored = h.state().feedback.find(note => note.id === "iss-media")!;
    assert.deepEqual(stored.frames, [frame(png, 1, "Title"), frame(jpeg, 2), frame(mp4, 3, "Cut too early"), frame(mov, 4)]);
    assert.deepEqual(materials(), [png, jpeg, mp4, mov].map(file => [file.id, "pkg-final-1", "pending", file]));
  });

  it("accepts legacy image names and registers each file once on replay", async () => {
    const files = [media(8, "frame", "image/png"), media(9, "still.JPG", "image/png")];
    const payload = summary([issue("legacy", files.map(file => frame(file)))]);
    const receipt = await receive(payload);
    assert.deepEqual(receipt, { accepted: true, eventId: "evt-final-revision" });
    assert.deepEqual(await receive(payload), receipt);
    assert.deepEqual(materials().map(row => row[3]), files);
  });

  it("rejects a whole return whose frame file is not a strict PNG, JPEG, MP4 or MOV reference, writing nothing", async () => {
    const cases: [string, Row][] = [
      ["WebM video", media(5, "a.webm", "video/webm")],
      ["GIF image", media(5, "a.gif", "image/gif")],
      ["video MIME with an image name", media(5, "a.png", "video/mp4")],
      ["MP4 MIME with a MOV name", media(5, "a.mov", "video/mp4")],
      ["upper-case MIME", media(5, "a.mp4", "Video/MP4")],
      ["MIME parameters", media(5, "a.mp4", "video/mp4; codecs=avc1")],
      ["a video over 10 MiB", media(5, "a.mov", "video/quicktime", { size: QA_REVISION_LIMITS.imageBytes + 1 })],
      ["a media kind field", { ...media(5, "a.mp4", "video/mp4"), kind: "video" }],
      ["a non-guidance video", media(5, "a.mp4", "video/mp4", { purpose: "final_video" })],
    ];
    for (const [name, file] of cases)
      await h.rejectsUnchanged(() => receive(summary([issue("ok", [frame(png)]), issue("bad", [frame(file)])])), "DESERET_QA_REVISION_INVALID", 400)
        .catch(error => { throw new Error(`${name}: ${error.message}`); });
    await h.rejectsUnchanged(() => receive(summary([issue("a", [{ ...frame(mp4), mediaType: "video" }])])), "DESERET_QA_REVISION_INVALID", 400);
  });

  it("keeps the identity and scope rules for video frames", async () => {
    await h.rejectsUnchanged(() => receive(summary([issue("a", [frame(mov)]), issue("b", [frame({ ...mov, name: "other.mov" })])])), "DESERET_MEDIA_IDENTITY_CHANGED", 409);
    await receive(summary([issue("a", [frame(mov)])]));
    const [envelope, raw] = feedbackEnvelope("evt-late-note", [mov] as never);
    await h.rejectsUnchanged(() => h.service.receive(envelope, raw), "DESERET_MEDIA_SCOPE_CONFLICT", 409);
  });
});

const stableId = (value: string) => {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};

describe("Revision frame media: transfer handoff and projection", () => {
  let registered: { file: string; mimeType: string; name: string; taskIds: string[] }[];
  /** MIME type the fake registration stores for a file id; defaults to the copied manifest's own type. */
  let storedType: Record<string, string>;
  let jobs: ReturnType<typeof createDeseretIntegrationJobs>;
  beforeEach(() => {
    h = createHarness();
    registered = [];
    storedType = {};
    jobs = createDeseretIntegrationJobs({
      db: h.db, clock: () => Date.parse("2026-11-20T09:00:01.000Z"), reportDiagnostic: () => {},
      planTransfer: input => ({ id: "plan", receiptId: "plan", file: input.file, source: {}, target: {} }) as unknown as MaterialTransferPlan,
      async transferFile(input) { return { ...input.file, objectKey: `aigc-staging/${input.file.id}` }; },
      sourceReceipt: async () => { throw new Error("not used"); },
      async registerIncoming(_projectId, jobId, file: HandoffMaterial, _revision, _lease, _signal, taskIds) {
        registered.push({ file: file.id, mimeType: file.mimeType, name: file.name, taskIds: [...taskIds] });
        for (const taskId of taskIds) {
          const nativeId = `native-${file.id}-${taskId}`;
          h.addNative({ id: nativeId, taskId, directory: "02_客户素材", status: "available", name: file.name, mimeType: storedType[file.id] ?? file.mimeType, size: file.size, sha256: file.sha256! });
          h.db.sqlite.prepare("INSERT INTO deseret_inbox VALUES (?,?,?,?,?,?,?,?)").run(`material:${stableId(`${jobId}:${taskId}`)}`, "native-material", PROJECT, "h", "complete", JSON.stringify({ id: nativeId }), "t", "t");
        }
      },
      projectAuthority: async () => ({ sql: "EXISTS(SELECT 1 FROM projects WHERE id=?)", values: [PROJECT] }),
      withProject: (_projectId, work) => work(), deliver: async () => {},
    });
  });
  const drain = async () => { for (let round = 0; round < 3; round += 1) await jobs.materialTick(new AbortController().signal); };
  const projected = async (email: string) => (await h.service.workspace(email, PROJECT)).feedback.flatMap(note => (note.frames ?? []).map(item => item.file));

  it("hands each frame to native registration with its own name, MIME type and receiving tasks", async () => {
    const [envelope, raw] = feedbackEnvelope("evt-note", [media(9, "reference.mp4", "video/mp4")] as never);
    await h.service.receive(envelope, raw);
    await receive(summary([issue("a", [frame(png), frame(mov)]), issue("b", [frame(mp4)], "final-task-2")]));
    await drain();
    assert.deepEqual(registered.sort((a, b) => a.file.localeCompare(b.file)), [
      { file: "guide-1", mimeType: "image/png", name: "title.png", taskIds: ["task-1"] },
      { file: "guide-3", mimeType: "video/mp4", name: "cut.mp4", taskIds: ["task-2"] },
      { file: "guide-4", mimeType: "video/quicktime", name: "grade.mov", taskIds: ["task-1"] },
      { file: "guide-9", mimeType: "video/mp4", name: "reference.mp4", taskIds: ["task-1", "task-2"] },
    ]);
  });

  it("projects each account's ready copy with the frame's name and MIME type", async () => {
    await receive(summary([issue("a", [frame(png), frame(mov)]), issue("b", [frame(mp4)], "final-task-2")]));
    await drain();
    assert.deepEqual(await projected(MAKER), [
      { id: "guide-1", version: 1, name: "title.png", mimeType: "image/png", size: png.size, state: "ready", nativeVersionId: "native-guide-1-task-1" },
      { id: "guide-4", version: 1, name: "grade.mov", mimeType: "video/quicktime", size: mov.size, state: "ready", nativeVersionId: "native-guide-4-task-1" },
    ]);
    assert.deepEqual(await projected(OTHER_MAKER), [
      { id: "guide-3", version: 1, name: "cut.mp4", mimeType: "video/mp4", size: mp4.size, state: "ready", nativeVersionId: "native-guide-3-task-2" },
    ]);
  });

  it("does not offer a native copy whose stored MIME type differs from the frame's", async () => {
    storedType = { "guide-4": "image/png" };
    await receive(summary([issue("a", [frame(png), frame(mov)])]));
    await drain();
    assert.deepEqual((await projected(MAKER)).map(file => [file.id, file.mimeType, file.state, file.nativeVersionId ?? "-"]), [
      ["guide-1", "image/png", "ready", "native-guide-1-task-1"],
      ["guide-4", "video/quicktime", "ready", "-"],
    ]);
  });


});
