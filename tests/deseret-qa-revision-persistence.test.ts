// P1 regression: a final QA return (`review.concluded` with `qaRevision`) used to be accepted while its summary,
// issues, intervals and frames were silently dropped. These tests run the real integration service on SQLite.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { concludedEnvelope, createHarness, feedbackEnvelope, guidanceImage, LEAD, MAKER, OTHER_MAKER, OTHER_QC, PROJECT, QC, type Harness, type Row } from "./support/deseret-harness";

const issue = (id: string, extra: Row = {}): Row => ({ id, role: "marketing", actorId: "mkt-3", sceneId: "final-task-1", sceneVersion: 1, body: `Reason ${id}`, frames: [], ...extra });
const frame = (seconds: number, n: number, caption?: string, override: Row = {}) => ({ seconds, file: guidanceImage(n, override), ...(caption === undefined ? {} : { caption }) });
const summary = (extra: Row = {}): Row => ({ actorId: "qa-reviewer-7", body: "  Fix the listed issues.  ", sceneId: "final-task-1", seconds: 27, ...extra });
const issues = [
  issue("iss-text", { role: "publisher_qa", actorId: "qa-reviewer-7", body: "  Text-only reason, no time.  " }),
  issue("iss-range", { role: "creative", actorId: "cr-2", seconds: 12.345, endSeconds: 14.5, body: "Subtitles cover the title." }),
  issue("iss-frames", { seconds: 8, frames: [frame(8, 1, "Title hidden"), frame(9.25, 2)] }),
  issue("iss-other-task", { sceneId: "final-task-2", seconds: 3, frames: [frame(3, 3)] }),
];

let h: Harness;
const receive = (qaRevision: unknown, eventId = "evt-final-revision", payload: Row = {}) => {
  const [envelope, raw] = concludedEnvelope(qaRevision, eventId, payload);
  return h.service.receive(envelope, raw);
};
const materialRows = () => h.db.sqlite.prepare("SELECT file_id,file_version,package_id,direction,state,manifest_json FROM deseret_material_tasks ORDER BY file_id").all() as Row[];

describe("Final QA return: persistence of qaRevision (P1)", () => {
  beforeEach(() => { h = createHarness(); });

  it("persists a text-only summary with its time, the conclusion and the task status in one write", async () => {
    assert.deepEqual(await receive(summary()), { accepted: true, eventId: "evt-final-revision" });
    const state = h.state();
    assert.deepEqual(state.feedback, [{
      id: "evt-final-revision", type: "review.feedback", packageId: "pkg-final-1", body: "Fix the listed issues.", actorId: "qa-reviewer-7",
      createdAt: "2026-11-20T08:00:00.000Z", sceneId: "final-task-1", mode: "revision", seconds: 27,
    }]);
    assert.equal(state.packages[1].conclusion, "revision");
    assert.deepEqual(state.revisionSceneIds, ["final-task-1", "final-task-2"]);
    assert.equal(state.stage, "revision");
    assert.deepEqual(h.db.sqlite.prepare("SELECT id,status FROM language_projects WHERE project_id=? ORDER BY id").all(PROJECT).map(row => ({ ...row })), [{ id: "task-1", status: "制作中" }, { id: "task-2", status: "制作中" }]);
    assert.equal(materialRows().length, 0);
    assert.equal((h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM deseret_inbox WHERE id='evt-final-revision' AND state='complete'").get() as Row).n, 1);
  });

  it("persists text, interval and framed issues in the publisher's order, plus one transfer task per image", async () => {
    await receive(summary({ issues }));
    const state = h.state();
    assert.deepEqual(state.feedback.map(note => note.id), ["evt-final-revision", "iss-text", "iss-range", "iss-frames", "iss-other-task"]);
    assert.deepEqual(state.feedback[0].issueIds, ["iss-text", "iss-range", "iss-frames", "iss-other-task"]);
    const [, text, range, framed, other] = state.feedback;
    assert.deepEqual(text, { id: "iss-text", type: "review.feedback", packageId: "pkg-final-1", body: "Text-only reason, no time.", actorId: "qa-reviewer-7",
      createdAt: "2026-11-20T08:00:00.000Z", sceneId: "final-task-1", mode: "revision", role: "publisher_qa", sceneVersion: 1, revisionId: "evt-final-revision", frames: [] });
    assert.equal(range.seconds, 12.345);
    assert.equal(range.endSeconds, 14.5);
    assert.equal(range.role, "creative");
    assert.deepEqual(framed.frames, [{ seconds: 8, caption: "Title hidden", file: guidanceImage(1) }, { seconds: 9.25, file: guidanceImage(2) }]);
    assert.equal(other.sceneId, "final-task-2");
    assert.deepEqual(materialRows().map(row => [row.file_id, row.file_version, row.package_id, row.direction, row.state, JSON.parse(String(row.manifest_json))]), [
      ["guide-1", 1, "pkg-final-1", "deseret_to_aigc", "pending", guidanceImage(1)],
      ["guide-2", 1, "pkg-final-1", "deseret_to_aigc", "pending", guidanceImage(2)],
      ["guide-3", 1, "pkg-final-1", "deseret_to_aigc", "pending", guidanceImage(3)],
    ]);
  });

  it("returns the stored response for an identical redelivery and writes nothing", async () => {
    const first = await receive(summary({ issues }));
    const before = h.snapshot();
    assert.deepEqual(await receive(summary({ issues })), first);
    assert.deepEqual(h.snapshot(), before);
  });

  it("rejects a redelivery with the same event id but different content, unchanged", async () => {
    await receive(summary({ issues }));
    await h.rejectsUnchanged(() => receive(summary({ body: "Different reason." })), "DESERET_REPLAY_CONFLICT", 409);
  });

  it("writes nothing when the transaction fails, and accepts the same event on retry", async () => {
    h.failSummary();
    const before = h.snapshot();
    await assert.rejects(() => receive(summary({ issues })));
    assert.deepEqual(h.snapshot(), before);
    h.failSummary(false);
    assert.deepEqual(await receive(summary({ issues })), { accepted: true, eventId: "evt-final-revision" });
    assert.equal(h.state().feedback.length, 5);
    assert.equal(materialRows().length, 3);
  });

  it("rejects an invalid return as a whole, without partial writes", async () => {
    const cases: [string, unknown, string, number][] = [
      ["a blank reason", summary({ body: "   " }), "DESERET_QA_REVISION_INVALID", 400],
      ["an interval that ends before it starts", summary({ issues: [issue("a", { seconds: 5, endSeconds: 5 })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["a time beyond the reviewed scene", summary({ issues: [issue("a", { seconds: 31 })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["a WebP frame", summary({ issues: [issue("a", { frames: [frame(1, 1, undefined, { mimeType: "image/webp" })] })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["annotation data beside the frame", summary({ issues: [issue("a", { frames: [{ ...frame(1, 1), region: { x: 0, y: 0, width: 1, height: 1 } }] })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["a non-guidance file", summary({ issues: [issue("a", { frames: [frame(1, 1, undefined, { purpose: "final_video" })] })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["a scene version that was not reviewed", summary({ issues: [issue("a", { sceneVersion: 2 })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["one valid and one invalid issue", summary({ issues: [issue("ok"), issue("bad", { role: "author" })] }), "DESERET_QA_REVISION_INVALID", 400],
      ["more than 12 frames on one issue", summary({ issues: [issue("a", { frames: Array.from({ length: 13 }, (_, n) => frame(1, n + 1)) })] }), "DESERET_QA_REVISION_LIMIT", 422],
      ["one image id with two manifests", summary({ issues: [issue("a", { frames: [frame(1, 1)] }), issue("b", { frames: [frame(1, 1, undefined, { size: 9 })] })] }), "DESERET_MEDIA_IDENTITY_CHANGED", 409],
    ];
    for (const [name, qaRevision, code, status] of cases)
      await h.rejectsUnchanged(() => receive(qaRevision), code, status).catch(error => { throw new Error(`${name}: ${error.message}`); });
  });

  it("rejects a qaRevision on an approved conclusion", async () => {
    await h.rejectsUnchanged(() => receive(summary(), "evt-approved", { conclusion: "approved", decisions: [{ sceneId: "final-task-1", sceneVersion: 1, decision: "approved" }, { sceneId: "final-task-2", sceneVersion: 1, decision: "approved" }] }),
      "DESERET_QA_REVISION_INVALID", 400);
  });

  it("keeps the earlier behaviour for a conclusion without qaRevision", async () => {
    await receive(undefined);
    const state = h.state();
    assert.deepEqual(state.feedback, []);
    assert.equal(state.packages[1].conclusion, "revision");
    assert.equal(materialRows().length, 0);
  });

  it("reuses the transfer task of an image already sent, and rejects a changed manifest for it", async () => {
    const [envelope, raw] = feedbackEnvelope("evt-note", [guidanceImage(1)] as never);
    await h.service.receive(envelope, raw);
    assert.equal(materialRows().length, 1);
    await h.rejectsUnchanged(() => receive(summary({ issues: [issue("a", { frames: [frame(1, 1, undefined, { size: 99 })] })] })), "DESERET_MEDIA_IDENTITY_CHANGED", 409);
    await receive(summary({ issues: [issue("a", { frames: [frame(1, 1)] })] }));
    assert.equal(materialRows().length, 1);
  });

  it("rejects a later ordinary attachment that reuses a frame image of the same publication", async () => {
    await receive(summary({ issues: [issue("a", { frames: [frame(1, 1)] })] }));
    const [envelope, raw] = feedbackEnvelope("evt-late-note", [guidanceImage(1)] as never);
    await h.rejectsUnchanged(() => h.service.receive(envelope, raw), "DESERET_MEDIA_SCOPE_CONFLICT", 409);
  });
});

describe("Final QA return: who receives the records (existing permissions)", () => {
  beforeEach(async () => {
    h = createHarness();
    await receive(summary({ issues }));
  });
  const ids = async (email: string) => (await h.service.workspace(email, PROJECT)).feedback.map(note => note.id);

  it("shows the lead every record", async () => {
    assert.deepEqual(await ids(LEAD), ["evt-final-revision", "iss-text", "iss-range", "iss-frames", "iss-other-task"]);
  });

  it("shows the maker and QC of task-1 the summary and their own issues, with hidden issue ids removed", async () => {
    for (const email of [MAKER, QC]) {
      const workspace = await h.service.workspace(email, PROJECT);
      assert.deepEqual(workspace.feedback.map(note => note.id), ["evt-final-revision", "iss-text", "iss-range", "iss-frames"], email);
      assert.deepEqual(workspace.feedback[0].issueIds, ["iss-text", "iss-range", "iss-frames"], email);
    }
  });

  it("shows the other task's maker and QC only their issue, never the summary or its issue ids", async () => {
    for (const email of [OTHER_MAKER, OTHER_QC]) {
      const workspace = await h.service.workspace(email, PROJECT);
      assert.deepEqual(workspace.feedback.map(note => note.id), ["iss-other-task"], email);
      assert.equal(JSON.stringify(workspace.feedback).includes("Fix the listed issues"), false, email);
    }
  });

  it("projects frames without storage details, and reports them as transferring until registered", async () => {
    const workspace = await h.service.workspace(MAKER, PROJECT);
    const frames = workspace.feedback.find(note => note.id === "iss-frames")!.frames!;
    assert.deepEqual(frames.map(item => item.file), [
      { id: "guide-1", version: 1, name: "frame-1.png", mimeType: "image/png", size: 2049, state: "pending" },
      { id: "guide-2", version: 1, name: "frame-2.png", mimeType: "image/png", size: 2050, state: "pending" },
    ]);
    assert.equal(JSON.stringify(workspace.feedback).includes("aigc-guidance/"), false);
  });
});

// Acceptance blocker: a delivery of the same event that interleaves with the first one must get the first one's
// committed receipt, never a spurious "round closed" or stale-record error; a different body is still rejected.
describe("Final QA return: concurrent redelivery of one event (deterministic interleavings)", () => {
  beforeEach(() => { h = createHarness(); });
  const RECEIPT_LOOKUP = "SELECT sender,payload_hash,response_json,state FROM deseret_inbox";
  const STATE_READ_DONE = "SELECT id,status FROM language_projects WHERE project_id=? AND id IN";

  /** Starts delivery B, holds it at `prefix`, commits delivery A in full, then lets B continue. */
  async function interleave(prefix: string, late: () => Promise<unknown>, first: () => Promise<unknown>) {
    const gate = h.holdFirst(prefix);
    const lateResult = late().then(value => ({ value }), (error: unknown) => ({ error }));
    await gate.arrived;
    const committed = await first();
    const afterFirst = h.snapshot();
    gate.release();
    return { committed, late: await lateResult, afterFirst };
  }

  for (const [name, prefix] of [["its receipt lookup ran before the first commit", RECEIPT_LOOKUP], ["its state read ran before the first commit", STATE_READ_DONE]] as const) {
    it(`returns the committed receipt to a same-body delivery when ${name}`, async () => {
      const run = await interleave(prefix, () => receive(summary({ issues })), () => receive(summary({ issues })));
      assert.deepEqual(run.committed, { accepted: true, eventId: "evt-final-revision" });
      assert.deepEqual(run.late, { value: run.committed });
      assert.deepEqual(h.snapshot(), run.afterFirst);
      assert.equal(h.state().feedback.length, 5);
      assert.equal(materialRows().length, 3);
    });

    it(`still rejects the same event id with a different body when ${name}`, async () => {
      const run = await interleave(prefix, () => receive(summary({ body: "A different reason." })), () => receive(summary({ issues })));
      assert.ok("error" in run.late);
      assert.equal((run.late.error as { code?: string }).code, "DESERET_REPLAY_CONFLICT");
      assert.equal((run.late.error as { status?: number }).status, 409);
      assert.deepEqual(h.snapshot(), run.afterFirst);
    });
  }

  it("returns the committed receipt to an interleaved duplicate of an ordinary feedback event", async () => {
    const send = () => { const [envelope, raw] = feedbackEnvelope("evt-note", [guidanceImage(7)] as never); return h.service.receive(envelope, raw); };
    const run = await interleave(RECEIPT_LOOKUP, send, send);
    assert.deepEqual(run.late, { value: run.committed });
    assert.deepEqual(h.snapshot(), run.afterFirst);
    assert.deepEqual(h.state().feedback.map(note => note.id), ["evt-note"]);
  });
});
