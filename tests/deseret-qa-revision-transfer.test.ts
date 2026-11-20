// P1 regression, transfer side: frames of a persisted final QA return are copied and registered by the real
// transfer worker (createDeseretIntegrationJobs.materialTick → incomingMaterialTaskIds → registerIncoming).
// Only storage is replaced: `registerIncoming` writes, for exactly the tasks the worker passes, what the runtime
// writes per task (an `available` version in that task's 02 folder plus its per-task receipt).
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeseretIntegrationJobs } from "../db/deseret-integration-jobs";
import type { HandoffMaterial } from "../lib/deseret-integration-contract";
import type { DeseretIntegrationState } from "../lib/deseret-workspace";
import type { MaterialTransferPlan } from "../runtime/deseret-material-transfer";
import { concludedEnvelope, createHarness, feedbackEnvelope, guidanceImage, LEAD, MAKER, OTHER_MAKER, OTHER_QC, PROJECT, QC, type Harness, type Row } from "./support/deseret-harness";

const stableId = (value: string) => {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};
const issue = (id: string, sceneId: string, images: number[]): Row => ({
  id, role: "marketing", actorId: "mkt-3", sceneId, sceneVersion: 1, body: `Reason ${id}`, seconds: 2, endSeconds: 6, frames: images.map(n => ({ seconds: 3, file: guidanceImage(n) })),
});

let h: Harness;
let now: number;
let registered: { file: string; taskIds: string[] }[];
let failTransfer: (file: HandoffMaterial) => void;
let jobs: ReturnType<typeof createDeseretIntegrationJobs>;

function setup() {
  h = createHarness();
  now = Date.parse("2026-11-20T09:00:01.000Z");
  registered = [];
  failTransfer = () => {};
  jobs = createDeseretIntegrationJobs({
    db: h.db,
    clock: () => now,
    reportDiagnostic: () => {},
    planTransfer: input => ({ id: "plan", receiptId: "plan", file: input.file, source: {}, target: {} }) as unknown as MaterialTransferPlan,
    async transferFile(input) { failTransfer(input.file); return { ...input.file, objectKey: `aigc-staging/${input.file.id}` }; },
    sourceReceipt: async () => { throw new Error("not used"); },
    async registerIncoming(_projectId, jobId, file, _sourceRevision, _leaseId, _signal, taskIds) {
      registered.push({ file: file.id, taskIds: [...taskIds] });
      for (const taskId of taskIds) {
        const receipt = `material:${stableId(`${jobId}:${taskId}`)}`;
        if (h.db.sqlite.prepare("SELECT 1 FROM deseret_inbox WHERE id=?").get(receipt)) continue;
        const nativeId = `native-${file.id}-${taskId}`;
        h.addNative({ id: nativeId, taskId, directory: "02_客户素材", status: "available", name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256! });
        h.db.sqlite.prepare("INSERT INTO deseret_inbox VALUES (?,?,?,?,?,?,?,?)").run(receipt, "native-material", PROJECT, "h", "complete", JSON.stringify({ id: nativeId }), "t", "t");
      }
    },
    projectAuthority: async () => ({ sql: "EXISTS(SELECT 1 FROM projects WHERE id=?)", values: [PROJECT] }),
    withProject: (_projectId, work) => work(),
    deliver: async () => {},
  });
}
async function drain() {
  for (let round = 0; round < 5; round += 1) await jobs.materialTick(new AbortController().signal);
}
async function conclude() {
  // guide-1: issues on both scenes (task-1 and task-2). guide-2: task-2 only. guide-3: task-1 only.
  const [envelope, raw] = concludedEnvelope({ actorId: "qa-reviewer-7", body: "Fix the listed issues.", sceneId: "final-task-1",
    issues: [issue("a", "final-task-1", [1, 3]), issue("b", "final-task-2", [2]), issue("c", "final-task-2", [1])] });
  return h.service.receive(envelope, raw);
}
const material = (n: number) => h.db.sqlite.prepare("SELECT state,last_error,attempts FROM deseret_material_tasks WHERE file_id=?").get(`guide-${n}`) as Row;
const scopeOf = (n: number) => registered.filter(call => call.file === `guide-${n}`).map(call => call.taskIds);
const frameCopies = async (email: string) => (await h.service.workspace(email, PROJECT)).feedback
  .flatMap(note => (note.frames ?? []).map(frame => `${note.id}:${frame.file.id}:${frame.file.state}:${frame.file.nativeVersionId ?? "-"}`));
function editState(change: (state: DeseretIntegrationState) => void) {
  const state = h.state();
  change(state);
  h.db.sqlite.prepare("UPDATE deseret_project_links SET state_json=? WHERE id=?").run(JSON.stringify(state), PROJECT);
}

describe("Final QA return frames: transfer, task scope and retry", () => {
  beforeEach(setup);

  it("registers each frame only in its issues' scene tasks and hands each account its own task's copy", async () => {
    await conclude();
    await drain();
    assert.deepEqual([1, 2, 3].map(n => material(n).state), ["ready", "ready", "ready"]);
    assert.deepEqual([scopeOf(1), scopeOf(2), scopeOf(3)], [[["task-1", "task-2"]], [["task-2"]], [["task-1"]]]);
    for (const email of [MAKER, QC]) assert.deepEqual(await frameCopies(email), [
      "a:guide-1:ready:native-guide-1-task-1", "a:guide-3:ready:native-guide-3-task-1",
    ], email);
    for (const email of [OTHER_MAKER, OTHER_QC]) assert.deepEqual(await frameCopies(email), [
      "b:guide-2:ready:native-guide-2-task-2", "c:guide-1:ready:native-guide-1-task-2",
    ], email);
    assert.equal((await frameCopies(LEAD)).length, 4);
  });

  it("keeps ordinary review attachments shared with every task", async () => {
    const [envelope, raw] = feedbackEnvelope("evt-note", [guidanceImage(5)] as never);
    await h.service.receive(envelope, raw);
    await drain();
    assert.deepEqual(scopeOf(5), [["task-1", "task-2"]]);
  });

  it("does not register a frame again when the worker runs again", async () => {
    await conclude();
    await drain();
    const calls = registered.length;
    await drain();
    now += 10 * 60_000;
    await drain();
    assert.equal(registered.length, calls);
  });

  it("retries a failed copy automatically after its backoff", async () => {
    let failures = 1;
    failTransfer = file => { if (file.id === "guide-2" && failures-- > 0) throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); };
    await conclude();
    await drain();
    assert.deepEqual({ ...material(2) }, { state: "failed", last_error: "ECONNRESET", attempts: 1 });
    assert.deepEqual(await frameCopies(OTHER_MAKER), ["b:guide-2:failed:-", "c:guide-1:ready:native-guide-1-task-2"]);
    now += 61_000;
    await drain();
    assert.deepEqual({ ...material(2) }, { state: "ready", last_error: null, attempts: 2 });
    assert.deepEqual(scopeOf(2), [["task-2"]]);
  });

  it("fails an unbound frame without registering it anywhere, and registers it after the lead's retry once bound", async () => {
    await conclude();
    editState(state => { state.feedback.find(note => note.id === "b")!.sceneVersion = 9; });
    await drain();
    assert.deepEqual({ ...material(2) }, { state: "failed", last_error: "DESERET_FRAME_TASK_UNBOUND", attempts: 1 });
    assert.deepEqual(scopeOf(2), []);
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM project_files WHERE original_name='frame-2.png'").get()!.n, 0);
    const lead = await h.service.workspace(LEAD, PROJECT);
    assert.ok(lead.actions.includes("materials.retry"));
    assert.deepEqual(lead.transfers.filter(item => item.name === "frame-2.png").map(item => [item.state, item.lastError]), [["failed", "DESERET_FRAME_TASK_UNBOUND"]]);
    editState(state => { state.feedback.find(note => note.id === "b")!.sceneVersion = 1; });
    const current = await h.service.workspace(LEAD, PROJECT);
    await h.service.command(LEAD, PROJECT, { requestId: "retry-1", expectedRevision: current.revision, action: "materials.retry", payload: {} });
    assert.equal(material(2).state, "pending");
    await drain();
    assert.equal(material(2).state, "ready");
    assert.deepEqual(scopeOf(2), [["task-2"]]);
  });

  it("keeps the frame's records when its transfer fails, so nothing is dropped silently", async () => {
    failTransfer = () => { throw Object.assign(new Error("denied"), { code: "TRANSFER_NOT_CONFIGURED" }); };
    await conclude();
    await drain();
    assert.equal(material(1).state, "waiting_config");
    assert.deepEqual(h.state().feedback.map(note => note.id), ["evt-final-revision", "a", "b", "c"]);
    assert.deepEqual(await frameCopies(MAKER), ["a:guide-1:waiting_config:-", "a:guide-3:waiting_config:-"]);
  });
});
