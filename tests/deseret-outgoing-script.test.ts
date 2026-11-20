// Production scripts stay inside AIGC. No storyboard or final publication may carry script text to Deseret: not a
// new publication, not an event already queued by an earlier version, and not a resend after failure, timeout,
// lease expiry or the lead's outbox retry. The scripts remain in AIGC's own production state.
//
// Resends of a stripped legacy event must stay idempotent. Deseret binds an event id to the SHA-256 of the exact
// body it committed. If it already holds the legacy body (its acknowledgement was lost), the stripped resend gets
// `request_reused`; AIGC then asks Deseret's receipt endpoint about the legacy wire body's SHA-256 and treats the
// event as delivered only on a matching receipt. Every other conflict stays a failure.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeseretIntegrationJobs, type JobDiagnostic } from "../db/deseret-integration-jobs";
import { deseretOutboxStatement } from "../db/deseret-integration";
import type { DeseretIntegrationState, DeseretPublishedFile } from "../lib/deseret-workspace";
import { createHarness, EXTERNAL, finalReviewState, LEAD, PROJECT, SOURCE, type Harness, type Row } from "./support/deseret-harness";

const SECRET_STORYBOARD = "CONFIDENTIAL storyboard narration: the hero opens the book.";
const SECRET_FINAL = "CONFIDENTIAL final narration A\n\nCONFIDENTIAL final narration B";
const QUEUED_AT = "2026-11-20T08:00:00.000Z";
const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

type Query = { eventId: string; projectId: string; bodySha256: string };
/** Deseret's inbound behaviour as far as AIGC can observe it: receipts keyed by event id and exact body hash. */
class FakeDeseret {
  receipts = new Map<string, { projectId: string; hash: string }>();
  sent: { eventId: string; body: string }[] = [];
  queries: Query[] = [];
  /** Scripted outcomes for the next deliveries: lose the acknowledgement, or answer a business conflict. */
  script: ({ loseAck: true } | { conflict: string | null; status?: number })[] = [];
  receiptDown = false;
  deliver = async (body: string, eventId: string) => {
    this.sent.push({ eventId, body });
    const step = this.script.shift();
    if (step && "conflict" in step) throw remote(step.status ?? 409, step.conflict);
    const existing = this.receipts.get(eventId);
    if (existing) {
      if (existing.hash !== sha(body)) throw remote(409, "request_reused");
      return;
    }
    this.receipts.set(eventId, { projectId: JSON.parse(body).projectId, hash: sha(body) });
    if (step && "loseAck" in step) throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError", code: "ETIMEDOUT" });
  };
  confirmReceipt = async (query: Query) => {
    this.queries.push(query);
    if (this.receiptDown) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const receipt = this.receipts.get(query.eventId);
    return Boolean(receipt && receipt.projectId === query.projectId && receipt.hash === query.bodySha256);
  };
}
/** The coded error the runtime delivery raises for a non-2xx answer (see the contract test). */
const remote = (status: number, code: string | null) =>
  Object.assign(new Error("Integration delivery failed."), { code: `REMOTE_${status}`, httpStatus: status, ...(code ? { remoteCode: code } : {}) });

let h: Harness;
let peer: FakeDeseret;
let now: number;
let diagnostics: JobDiagnostic[];
let jobs: ReturnType<typeof createDeseretIntegrationJobs>;

const publishedFile: DeseretPublishedFile = {
  id: "file-sb-2", fileVersionId: "file-sb-2", languageTaskId: "task-1", version: 1, name: "scene-1-v2.mp4", size: 4096,
  purpose: "storyboard_video", mimeType: "video/mp4", storageProfileId: "wasabi-main", objectKey: "projects/p1/file-sb-2.mp4", sha256: "b".repeat(64),
};
function setup(initial: DeseretIntegrationState = finalReviewState()) {
  h = createHarness(initial);
  peer = new FakeDeseret();
  now = Date.parse("2026-11-20T09:00:01.000Z");
  diagnostics = [];
  jobs = createDeseretIntegrationJobs({
    db: h.db,
    clock: () => now,
    reportDiagnostic: event => { diagnostics.push(event); },
    planTransfer: () => { throw new Error("not used"); },
    transferFile: async () => { throw new Error("not used"); },
    sourceReceipt: async () => { throw new Error("not used"); },
    registerIncoming: async () => { throw new Error("not used"); },
    projectAuthority: async () => ({ sql: "EXISTS(SELECT 1 FROM projects WHERE id=?)", values: [PROJECT] }),
    withProject: (_projectId, work) => work(),
    deliver: peer.deliver,
    confirmReceipt: peer.confirmReceipt,
  } as Parameters<typeof createDeseretIntegrationJobs>[0]);
}
const tick = () => jobs.outboxTick(new AbortController().signal);
const later = () => { now += 10 * 60 * 1000; };

const legacyScene = (packageId: string, script: string, n = 1): Row => ({
  id: `${packageId}-scene-${n}`, number: n, version: 1, duration: 30, languageTaskId: "task-1",
  narration: { en: script, zh: "" }, characterIds: [], video: { id: `file-${packageId}-${n}`, version: 1, kind: "video" },
});
/** A review.published event exactly as the previous version queued it, with the script in `narration.en`. */
function legacyPublication(packageId: string, phase: "storyboard" | "final", script: string) {
  return {
    package: { id: packageId, phase, version: 1, publicationId: `pub-${packageId}`, publishedAt: QUEUED_AT, scenes: [legacyScene(packageId, script)] },
    files: [],
  };
}
/** Every scene array Deseret reads: `payload.package.scenes` and the older top-level `payload.scenes`. */
const sceneArrays = (body: string) => {
  const payload = JSON.parse(body).payload as { package?: { scenes?: Row[] }; scenes?: Row[] };
  return [payload.package?.scenes, payload.scenes].filter((scenes): scenes is Row[] => Array.isArray(scenes));
};
let sequence = 0;
function queue(type: Parameters<typeof deseretOutboxStatement>[4], payload: Row, row: Row = {}) {
  deseretOutboxStatement(h.db, PROJECT, EXTERNAL, SOURCE, type, payload, QUEUED_AT).run();
  const stored = h.db.sqlite.prepare("SELECT id,body_json FROM deseret_outbox WHERE sequence IS NULL").get() as Row;
  const id = String(stored.id);
  h.db.sqlite.prepare("UPDATE deseret_outbox SET sequence=? WHERE id=?").run(++sequence, id);
  for (const [column, value] of Object.entries(row)) h.db.sqlite.prepare(`UPDATE deseret_outbox SET ${column}=? WHERE id=?`).run(value as string | number, id);
  return { id, body: String(stored.body_json) };
}
const outbox = (id: string) => ({ ...(h.db.sqlite.prepare("SELECT state,last_error,body_json FROM deseret_outbox WHERE id=?").get(id) as Row) });
/** No script text and no `narration` or `script` key in any scene array of any forwarded body. */
function assertNoScript(body: string) {
  assert.equal(body.includes("CONFIDENTIAL"), false, body);
  for (const scenes of sceneArrays(body))
    for (const scene of scenes) assert.deepEqual(["narration", "script"].filter(key => Object.hasOwn(scene, key)), [], JSON.stringify(scene));
}
function assertNoScriptSent() {
  assert.ok(peer.sent.length > 0, "something was delivered");
  for (const { body } of peer.sent) assertNoScript(body);
}

describe("New publications carry no production script", () => {
  beforeEach(() => {
    sequence = 0;
    const initial = finalReviewState();
    initial.scenes[0].script = SECRET_STORYBOARD;
    initial.packages.push({ id: "pkg-sb-2", phase: "storyboard", version: 2, publicationId: "pub-sb-2", publishedAt: QUEUED_AT, filesReady: false,
      scenes: [{ ...initial.scenes[0], version: 2, fileVersionId: publishedFile.id }], files: [publishedFile] });
    setup(initial);
    const target = { id: publishedFile.id, version: 1, size: publishedFile.size, sha256: publishedFile.sha256, purpose: "storyboard_video", storageProfileId: "deseret-main",
      objectKey: `aigc-review/${EXTERNAL}/file-sb-2.mp4`, name: publishedFile.name, mimeType: publishedFile.mimeType };
    h.db.sqlite.prepare("INSERT INTO deseret_material_tasks (id,project_id,source_revision,file_id,file_version,manifest_json,direction,package_id,target_json,state,attempts,created_at,updated_at,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("publication-task", PROJECT, SOURCE, publishedFile.id, 1, JSON.stringify(publishedFile), "aigc_to_deseret", "pkg-sb-2", JSON.stringify(target), "ready", 1, QUEUED_AT, QUEUED_AT, QUEUED_AT);
  });

  it("queues and sends review.published without narration or script, and keeps the script in AIGC's state", async () => {
    await jobs.reconcile(PROJECT);
    const [row] = h.db.sqlite.prepare("SELECT id,body_json FROM deseret_outbox WHERE event_type='review.published'").all() as Row[];
    assertNoScript(String(row.body_json));
    // Every other scene field is still published.
    assert.deepEqual(JSON.parse(String(row.body_json)).payload.package.scenes, [{ id: "scene-1", number: 1, version: 2, duration: 30, languageTaskId: "task-1",
      characterIds: [], video: { id: publishedFile.id, version: 1, kind: "video" } }]);
    h.db.sqlite.prepare("UPDATE deseret_outbox SET sequence=1").run();
    assert.deepEqual(await tick(), []);
    assertNoScriptSent();
    assert.equal(peer.sent[0].body, String(row.body_json), "a new event is sent byte for byte as queued");
    assert.equal(outbox(String(row.id)).state, "delivered");
    const state = h.state();
    assert.equal(state.packages.find(pack => pack.id === "pkg-sb-2")!.scenes[0].script, SECRET_STORYBOARD);
    assert.equal(state.scenes[0].script, SECRET_STORYBOARD);
  });
});

describe("Events queued by the previous version are sent without script text", () => {
  beforeEach(() => { sequence = 0; setup(); });

  it("strips a pending storyboard and a pending final publication and keeps the stored rows unchanged", async () => {
    const storyboard = queue("review.published", legacyPublication("pkg-old-sb", "storyboard", SECRET_STORYBOARD));
    const final = queue("review.published", legacyPublication("pkg-old-final", "final", SECRET_FINAL));
    await tick(); await tick();
    assertNoScriptSent();
    assert.deepEqual(peer.sent.map(item => item.eventId), [storyboard.id, final.id]);
    for (const event of [storyboard, final]) {
      assert.equal(outbox(event.id).state, "delivered");
      assert.equal(outbox(event.id).body_json, event.body, "the queued record is kept as it was");
    }
    // Only the narration key goes; identity and every other field of the event are the queued values.
    const sentFinal = JSON.parse(peer.sent[1].body), queuedFinal = JSON.parse(final.body);
    delete queuedFinal.payload.package.scenes[0].narration;
    assert.deepEqual(sentFinal, queuedFinal);
  });

  it("strips the older top-level payload.scenes, the script alias, and both arrays when both are present", async () => {
    const topLevel = queue("review.published", { package: { id: "pkg-top", phase: "storyboard", version: 1, publicationId: "pub-top", publishedAt: QUEUED_AT },
      scenes: [legacyScene("pkg-top", SECRET_STORYBOARD)], files: [] });
    const alias = queue("review.published", { package: { id: "pkg-alias", phase: "storyboard", version: 1, publicationId: "pub-alias", publishedAt: QUEUED_AT,
      scenes: [{ ...legacyScene("pkg-alias", SECRET_STORYBOARD), narration: undefined, script: SECRET_STORYBOARD }] }, files: [] });
    const both = queue("review.published", { package: { ...legacyPublication("pkg-both", "final", SECRET_FINAL).package,
      scenes: [legacyScene("pkg-both", SECRET_FINAL), { ...legacyScene("pkg-both", SECRET_STORYBOARD, 2), script: SECRET_STORYBOARD }] },
      scenes: [{ ...legacyScene("pkg-both", SECRET_FINAL), script: SECRET_FINAL }], files: [] });
    for (let round = 0; round < 3; round += 1) await tick();
    assert.deepEqual(peer.sent.map(item => item.eventId), [topLevel.id, alias.id, both.id]);
    assertNoScriptSent();
    // Apart from the removed keys every forwarded body equals the queued one.
    for (const [index, event] of [topLevel, alias, both].entries()) {
      const queued = JSON.parse(event.body);
      for (const scenes of [queued.payload.package?.scenes, queued.payload.scenes]) for (const scene of scenes ?? []) { delete scene.narration; delete scene.script; }
      assert.deepEqual(JSON.parse(peer.sent[index].body), queued);
      assert.equal(sceneArrays(peer.sent[index].body).flat().length, sceneArrays(event.body).flat().length, "no scene is dropped");
    }
  });

  it("resends a failed row, an expired sending lease and a lead retry without text, with identical bytes each time", async () => {
    const failed = queue("review.published", legacyPublication("pkg-failed", "storyboard", SECRET_STORYBOARD), { state: "failed", attempts: 2, last_error: "ETIMEDOUT" });
    const leased = queue("review.published", legacyPublication("pkg-leased", "final", SECRET_FINAL), { state: "sending", attempts: 1, lease_id: "old-lease", lease_expires_at: "2026-11-20T08:30:00.000Z" });
    await tick(); await tick();
    assert.deepEqual([outbox(failed.id).state, outbox(leased.id).state], ["delivered", "delivered"]);
    // A row parked by backoff is released by the lead's outbox retry and goes out stripped as well.
    const parked = queue("review.published", legacyPublication("pkg-parked", "storyboard", SECRET_STORYBOARD), { state: "failed", attempts: 5, next_attempt_at: "2026-11-21T00:00:00.000Z" });
    await tick();
    assert.equal(outbox(parked.id).state, "failed");
    const workspace = await h.service.workspace(LEAD, PROJECT);
    await h.service.command(LEAD, PROJECT, { requestId: "outbox-retry-1", expectedRevision: workspace.revision, action: "outbox.retry", payload: {} });
    await tick();
    assert.equal(outbox(parked.id).state, "delivered");
    assertNoScriptSent();
  });

  it("stays idempotent when the acknowledgement of a stripped send is lost", async () => {
    const event = queue("review.published", legacyPublication("pkg-ack", "storyboard", SECRET_STORYBOARD));
    peer.script.push({ loseAck: true });
    await tick();
    assert.equal(outbox(event.id).state, "failed");
    later();
    await tick();
    assert.equal(outbox(event.id).state, "delivered");
    assert.equal(peer.sent.length, 2);
    assert.equal(peer.sent[0].body, peer.sent[1].body, "the resend is byte for byte the first stripped send");
    assert.deepEqual(peer.queries, [], "no receipt lookup when Deseret accepts the same body");
    assertNoScriptSent();
  });
});

describe("Deseret already holds the legacy event and its acknowledgement was lost", () => {
  let legacy: { id: string; body: string };
  let next: { id: string; body: string };
  beforeEach(() => {
    sequence = 0;
    setup();
    // The previous version sent this exact body; Deseret committed it, then the response was lost.
    legacy = queue("review.published", legacyPublication("pkg-lost-ack", "storyboard", SECRET_STORYBOARD), { state: "sending", attempts: 1, lease_id: "old", lease_expires_at: "2026-11-20T08:30:00.000Z" });
    next = queue("project.archived", {});
  });

  it("confirms delivery through a matching receipt for the legacy wire body, then releases the queue", async () => {
    peer.receipts.set(legacy.id, { projectId: EXTERNAL, hash: sha(legacy.body) });
    await tick();
    assert.equal(outbox(legacy.id).state, "delivered");
    assert.equal(outbox(legacy.id).last_error, null);
    assert.deepEqual(peer.queries, [{ eventId: legacy.id, projectId: EXTERNAL, bodySha256: sha(legacy.body) }]);
    assert.ok(diagnostics.some(event => event.outcome === "delivered" && event.confirmation === "prior_receipt"));
    await tick();
    assert.equal(outbox(next.id).state, "delivered");
    assertNoScriptSent();
  });

  it("does not treat request_reused as delivered when the receipt does not match", async () => {
    peer.receipts.set(legacy.id, { projectId: EXTERNAL, hash: sha("some other body") });
    await tick();
    assert.deepEqual([outbox(legacy.id).state, outbox(legacy.id).last_error], ["failed", "DESERET_REPLAY_UNCONFIRMED"]);
    later();
    await tick();
    assert.equal(outbox(legacy.id).state, "failed", "still unconfirmed after the backoff");
    assert.equal(outbox(next.id).state, "pending", "later events wait behind the unconfirmed one");
    assertNoScriptSent();
  });

  it("does not accept a receipt for another project", async () => {
    peer.receipts.set(legacy.id, { projectId: "another-deseret-project", hash: sha(legacy.body) });
    await tick();
    assert.deepEqual([outbox(legacy.id).state, outbox(legacy.id).last_error], ["failed", "DESERET_REPLAY_UNCONFIRMED"]);
  });

  it("keeps the event failed when the receipt lookup itself fails", async () => {
    peer.receipts.set(legacy.id, { projectId: EXTERNAL, hash: sha(legacy.body) });
    peer.receiptDown = true;
    await tick();
    assert.deepEqual([outbox(legacy.id).state, outbox(legacy.id).last_error], ["failed", "ECONNRESET"]);
    peer.receiptDown = false;
    later();
    await tick();
    assert.equal(outbox(legacy.id).state, "delivered");
  });

  for (const conflict of ["publication_reused", "stale_publication", "closed", null])
    it(`never treats another conflict (${conflict ?? "409 without a code"}) as delivered, and does not query receipts`, async () => {
      peer.receipts.set(legacy.id, { projectId: EXTERNAL, hash: sha(legacy.body) });
      peer.script.push({ conflict });
      await tick();
      assert.deepEqual([outbox(legacy.id).state, outbox(legacy.id).last_error], ["failed", "REMOTE_409"]);
      assert.deepEqual(peer.queries, []);
      assert.equal(outbox(next.id).state, "pending");
    });

  for (const status of [400, 422, 503])
    it(`requires HTTP 409: request_reused with status ${status} is a failure and no receipt is queried`, async () => {
      peer.receipts.set(legacy.id, { projectId: EXTERNAL, hash: sha(legacy.body) });
      peer.script.push({ conflict: "request_reused", status });
      await tick();
      assert.deepEqual([outbox(legacy.id).state, outbox(legacy.id).last_error], ["failed", `REMOTE_${status}`]);
      assert.deepEqual(peer.queries, []);
    });
});

describe("request_reused for an event that was never altered", () => {
  beforeEach(() => { sequence = 0; setup(); });

  it("stays a failure without a receipt lookup: no other body was ever sent under that id", async () => {
    const event = queue("project.archived", {});
    peer.receipts.set(event.id, { projectId: EXTERNAL, hash: sha("a different body") });
    await tick();
    assert.deepEqual([outbox(event.id).state, outbox(event.id).last_error], ["failed", "REMOTE_409"]);
    assert.deepEqual(peer.queries, []);
  });
});
