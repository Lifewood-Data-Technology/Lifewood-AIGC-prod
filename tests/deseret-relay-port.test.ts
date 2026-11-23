// US–SG cross-account relay port: transfer runtime, relay transport and the job lanes that drive it.
// Synthetic data only: in-memory SQLite, fake storage transports and a loopback worker. No buckets or secrets.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeseretIntegrationJobs } from "../db/deseret-integration-jobs";
import type { HandoffMaterial } from "../lib/deseret-integration-contract";
import type { DeseretIntegrationState } from "../lib/deseret-workspace";
import {
  createDeseretMaterialTransfer, deseretStorageProfileId, materialTransferBudget, readMaterialTransferConfig,
  type MaterialTransferConfig, type MaterialTransferInput, type MaterialTransferPlan, type MaterialTransferTransport,
} from "../runtime/deseret-material-transfer";
import { createRelayRpc, createRelayTransport, readRelaySettings } from "../runtime/deseret-relay-transport";
import { RESPONSE_SIGNATURE_HEADER, signRpcResponse } from "../services/deseret-transfer-worker/protocol.mjs";
import { createWorker } from "../services/deseret-transfer-worker/worker.mjs";
import { concludedEnvelope, createHarness, finalReviewState, guidanceImage, LEAD, OTHER_PROJECT, PROJECT, SOURCE, type Harness, type Row } from "./support/deseret-harness";

const PART = 8 * 1024 ** 2;
const control = { keyId: "relay-port-test", secret: "relay-port-test-secret-".repeat(2) };
const us = { id: "", bucket: "publisher-us-test", endpoint: "https://s3.us-east-2.wasabisys.com", region: "us-east-2", prefix: "" };
us.id = deseretStorageProfileId(us);
const relayConfig: MaterialTransferConfig = {
  strategy: "deseret_relay", deseret: us,
  aigc: { id: "aigc-sg-test", bucket: "aigc-sg-test", endpoint: "https://s3.ap-southeast-1.wasabisys.com", region: "ap-southeast-1", prefix: "owned/" },
  accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret",
};
const digest = "c".repeat(64);
const incoming = (size = PART + 13): MaterialTransferInput => ({
  projectId: "project-1", deseretProjectId: "publisher-1", sourceRevision: "brief-v1", direction: "deseret_to_aigc",
  file: { id: "file-1", version: 1, size, sha256: digest, purpose: "reference", storageProfileId: us.id, objectKey: "sources/file-1", name: "file-1.bin", mimeType: "application/octet-stream" } as HandoffMaterial,
});
const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const missing = () => Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });

/** A fake two-bucket store: the source head answers with `sourceEtag`; the target appears once completed. */
function fakeStorage(options: { sourceEtag?: string; versionId?: string; retained?: { PartNumber: number; Size: number; ETag: string }[]; listError?: Error } = {}) {
  const calls: string[] = [];
  const ranges: string[] = [];
  let metadata: Record<string, string> | undefined;
  let completed: { PartNumber?: number; ETag?: string }[] | undefined;
  const transport: MaterialTransferTransport = {
    async head(value) {
      if (value.Bucket === us.bucket) { calls.push(`source-head:${value.VersionId ?? "-"}`); return { ContentLength: incoming().file.size, ETag: `"${options.sourceEtag ?? "pinned"}"`, VersionId: options.versionId, Metadata: { "lifewood-sha256": digest }, $metadata: {} }; }
      if (completed) return { ContentLength: incoming().file.size, ETag: '"target"', Metadata: metadata, $metadata: {} };
      throw missing();
    },
    async begin(value) { calls.push("begin"); metadata = value.Metadata; return { UploadId: `upload-${calls.length}`, $metadata: {} }; },
    async listParts() { calls.push("list"); if (options.listError) throw options.listError; return options.retained ?? []; },
    async copyPart(value) { calls.push("part"); ranges.push(String(value.CopySourceRange)); return { CopyPartResult: { ETag: `"part-${value.PartNumber}"` }, $metadata: {} }; },
    async complete(value) { calls.push("complete"); completed = value.MultipartUpload?.Parts; return { $metadata: {} }; },
    async abort() { calls.push("abort"); return {}; },
  };
  return { transport, calls, ranges, parts: () => completed, setMetadata: (value: Record<string, string>) => { metadata = value; } };
}

describe("relay transfer runtime: interrupted multipart and plans", () => {
  it("resumes an interrupted upload under its pinned source and sends only the missing part", async () => {
    const store = fakeStorage({ sourceEtag: "pinned", versionId: "v1", retained: [{ PartNumber: 1, Size: PART, ETag: '"kept"' }] });
    const service = createDeseretMaterialTransfer(relayConfig, store.transport);
    const plan = service.planTransfer(incoming());
    store.setMetadata({ "lifewood-integrity-algorithm": "sha256", "lifewood-integrity-value": digest, "lifewood-transfer": plan.receiptId });
    await service.transferFile({ ...incoming(), multipartUploadId: "upload-kept", sourcePin: { etag: "pinned", versionId: "v1" } }, plan);
    assert.deepEqual(store.calls, ["source-head:v1", "list", "part", "complete"]);
    assert.deepEqual(store.ranges, [`bytes=${PART}-${PART + 12}`]);
    assert.deepEqual(store.parts(), [{ PartNumber: 1, ETag: '"kept"' }, { PartNumber: 2, ETag: '"part-2"' }]);
  });

  it("never reuses parts when the persisted pin is missing or the source changed", async () => {
    for (const sourcePin of [undefined, { etag: "older" }, { etag: "pinned", versionId: "v0" }]) {
      const store = fakeStorage({ sourceEtag: "pinned", versionId: "v1", retained: [{ PartNumber: 1, Size: PART, ETag: '"kept"' }] });
      const service = createDeseretMaterialTransfer(relayConfig, store.transport);
      await assert.rejects(service.transferFile({ ...incoming(), multipartUploadId: "upload-kept", sourcePin }, service.planTransfer(incoming())), { code: "TRANSFER_SOURCE_CHANGED" });
      assert.ok(!store.calls.includes("list") && !store.calls.includes("part") && !store.calls.includes("abort"), JSON.stringify(store.calls));
    }
  });

  it("replaces an expired upload handle using its original source version", async () => {
    const store = fakeStorage({ sourceEtag: "pinned", versionId: "v1", listError: Object.assign(new Error("gone"), { name: "NoSuchUpload" }) });
    const service = createDeseretMaterialTransfer(relayConfig, store.transport);
    const created: unknown[] = [];
    await service.transferFile({ ...incoming(), multipartUploadId: "upload-lost", sourcePin: { etag: "pinned", versionId: "v1" }, onMultipartCreated: async (id, pin) => { created.push([id, pin]); } }, service.planTransfer(incoming()));
    assert.equal(created.length, 1);
    assert.deepEqual((created[0] as unknown[])[1], { etag: "pinned", versionId: "v1" });
    assert.deepEqual(store.calls.filter(call => call.startsWith("source-head")), ["source-head:v1", "source-head:v1"]);
    assert.equal(store.calls.filter(call => call === "begin").length, 1);
    assert.equal(store.calls.filter(call => call === "part").length, 2);
  });

  it("marks relay plans, allows cross-region relay, keeps server_copy same-region, and never matches across transports", () => {
    const relayPlan = createDeseretMaterialTransfer(relayConfig).planTransfer(incoming());
    assert.equal(relayPlan.transport, "deseret_relay");
    assert.throws(() => createDeseretMaterialTransfer({ ...relayConfig, strategy: "server_copy" }).planTransfer(incoming()), { code: "TRANSFER_REGION_UNSUPPORTED" });
    const sameRegion = { ...relayConfig, aigc: { ...relayConfig.aigc, endpoint: us.endpoint, region: us.region } };
    const copyPlan = createDeseretMaterialTransfer({ ...sameRegion, strategy: "server_copy" }).planTransfer(incoming());
    const sameRegionRelay = createDeseretMaterialTransfer(sameRegion).planTransfer(incoming());
    assert.equal(copyPlan.target.objectKey, sameRegionRelay.target.objectKey);
    assert.notEqual(copyPlan.id, sameRegionRelay.id);
    assert.equal(materialTransferBudget(2 * 1024 ** 3, "deseret_relay").leaseMs, 180000);
    assert.ok(materialTransferBudget(2 * 1024 ** 3, "deseret_relay").timeoutMs > 180000);
    assert.equal(materialTransferBudget(2 * 1024 ** 3).leaseMs, materialTransferBudget(2 * 1024 ** 3).timeoutMs + 120000);
  });

  it("stops before reading the source if the target lookup returned a relay routing error", async () => {
    const store = fakeStorage();
    let lookups = 0;
    store.transport.head = async () => {
      lookups++;
      throw Object.assign(new Error("route unavailable"), { code: "TRANSFER_NOT_CONFIGURED", $metadata: { httpStatusCode: 404 } });
    };
    const service = createDeseretMaterialTransfer(relayConfig, store.transport);
    await assert.rejects(service.transferFile(incoming()), { code: "TRANSFER_NOT_CONFIGURED" });
    assert.equal(lookups, 1);
    assert.deepEqual(store.calls, []);
  });

  it("aborts only through the recorded plan and treats an already-missing handle as cleaned", async () => {
    let aborted = 0;
    const transport = { ...fakeStorage().transport, async abort() { aborted++; throw Object.assign(new Error("gone"), { name: "NoSuchUpload" }); } };
    const service = createDeseretMaterialTransfer(relayConfig, transport);
    const plan = service.planTransfer(incoming());
    await service.abortTransfer({ ...incoming(), multipartUploadId: "upload-1" }, plan);
    assert.equal(aborted, 1);
    await assert.rejects(service.abortTransfer({ ...incoming(), multipartUploadId: "upload-1" }, { ...plan, id: "other" }), { code: "TRANSFER_PLAN_MISMATCH" });
    assert.equal(aborted, 1);
  });

  it("keeps the configured storage proxy for AIGC's own storage client in relay mode", () => {
    assert.equal(readMaterialTransferConfig(env({ WASABI_HTTP_PROXY: "http://127.0.0.1:7890" })).httpProxy, "http://127.0.0.1:7890");
    const settings = { origin: "https://publisher.invalid", keyId: control.keyId, secret: control.secret, allowLoopbackHttp: false };
    const plan = createDeseretMaterialTransfer(relayConfig).planTransfer(incoming());
    assert.throws(() => createRelayTransport({ ...relayConfig, httpProxy: "http://proxy.example.test:8080" }, incoming(), plan, settings), /WASABI_HTTP_PROXY/);
    createRelayTransport(relayConfig, incoming(), plan, settings).dispose?.();
  });
});

describe("relay control authentication", () => {
  async function withWorker(execute: (job: Row) => Promise<unknown>, run: (origin: string) => Promise<void>) {
    const server = createWorker(control, execute);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  const settings = (origin: string) => ({ origin, keyId: control.keyId, secret: control.secret, allowLoopbackHttp: true });

  it("accepts the worker's signed acknowledgement and refuses an altered or unsigned one", async () => {
    await withWorker(async () => ({ ETag: '"ok"' }), async origin => {
      assert.deepEqual(await createRelayRpc(settings(origin))({ op: "head" }, AbortSignal.timeout(5000)), { ETag: '"ok"' });
      const altered = createRelayRpc(settings(origin), async (url, init) => {
        const response = await fetch(url, init);
        const payload = await response.json() as Row;
        return Response.json({ ...payload, result: { ETag: '"forged"' } }, { status: response.status, headers: { [RESPONSE_SIGNATURE_HEADER]: response.headers.get(RESPONSE_SIGNATURE_HEADER) ?? "" } });
      });
      await assert.rejects(altered({ op: "head" }, AbortSignal.timeout(5000)), { code: "TRANSFER_NOT_CONFIGURED" });
    });
    const unsigned = createRelayRpc(settings("https://relay.invalid"), async (_url, init) => {
      const requestId = new Headers(init?.headers).get("x-lw-request-id");
      return Response.json({ requestId, result: { ETag: '"forged"' } });
    });
    await assert.rejects(unsigned({ op: "head" }, AbortSignal.timeout(5000)), { code: "TRANSFER_NOT_CONFIGURED" });
  });

  it("honours storage error codes only when signed; unsigned bodies map by HTTP status", async () => {
    await withWorker(async () => { throw Object.assign(new Error("gone"), { name: "NoSuchUpload", $metadata: { httpStatusCode: 404 } }); }, async origin => {
      await assert.rejects(createRelayRpc(settings(origin))({ op: "abort" }, AbortSignal.timeout(5000)), (error: Row) => error.name === "NoSuchUpload" && error.code === "TRANSFER_NOT_CONFIGURED");
    });
    const forged = createRelayRpc(settings("https://relay.invalid"), async () => Response.json({ code: "NoSuchUpload" }, { status: 409 }));
    await assert.rejects(forged({ op: "abort" }, AbortSignal.timeout(5000)), (error: Row) => error.name === "RELAY_FAILED" && error.code === "TRANSFER_RETRY");
    for (const response of [() => new Response("<html>Precondition Failed</html>", { status: 412 }), () => Response.json({ code: "SOURCE_SIZE_CHANGED" }, { status: 412 })])
      await assert.rejects(createRelayRpc(settings("https://relay.invalid"), async () => response())({ op: "part" }, AbortSignal.timeout(5000)), { code: "TRANSFER_NOT_CONFIGURED" });
    await withWorker(async () => { throw Object.assign(new Error("changed"), { code: "SOURCE_SIZE_CHANGED", status: 409 }); }, async origin => {
      await assert.rejects(createRelayRpc(settings(origin))({ op: "part" }, AbortSignal.timeout(5000)), { code: "TRANSFER_SOURCE_CHANGED" });
    });
    const wrongKey = createRelayRpc(settings("https://relay.invalid"), async (_url, init) => {
      const requestId = String(new Headers(init?.headers).get("x-lw-request-id"));
      const body = JSON.stringify({ code: "SOURCE_SIZE_CHANGED" });
      return new Response(body, { status: 409, headers: { [RESPONSE_SIGNATURE_HEADER]: signRpcResponse(body, { ...control, secret: "other-secret-".repeat(4) }, requestId, 409) } });
    });
    await assert.rejects(wrongKey({ op: "part" }, AbortSignal.timeout(5000)), { code: "TRANSFER_RETRY" });
  });

  it("keeps the relay secret separate from business HMAC and storage secrets, and HTTPS outside audit", () => {
    const relay = { LIFEWOOD_DESERET_RELAY_ORIGIN: "https://publisher.invalid", LIFEWOOD_DESERET_RELAY_KEY_ID: control.keyId, LIFEWOOD_DESERET_RELAY_SECRET: control.secret };
    assert.equal(readRelaySettings(env(relay)).origin, "https://publisher.invalid");
    for (const name of ["LIFEWOOD_DESERET_INTEGRATION_OUTGOING_SECRET", "LIFEWOOD_DESERET_INTEGRATION_INCOMING_SECRET", "WASABI_SECRET_ACCESS_KEY"])
      assert.throws(() => readRelaySettings(env({ ...relay, [name]: control.secret })), { code: "TRANSFER_NOT_CONFIGURED" });
    const loopback = { ...relay, LIFEWOOD_DESERET_RELAY_ORIGIN: "http://127.0.0.1:5390", LIFEWOOD_DESERET_RELAY_ALLOW_LOOPBACK_HTTP: "true" };
    assert.throws(() => readRelaySettings(env({ ...loopback, LIFEWOOD_ENV: "production" })), { code: "TRANSFER_NOT_CONFIGURED" });
    assert.equal(readRelaySettings(env({ ...loopback, LIFEWOOD_ENV: "audit" })).allowLoopbackHttp, true);
  });
});

// ---- Job lanes over the real jobs module and the SQLite harness ----
let h: Harness;
let now: number;
let planTransport: string;
let registered: { project: string; file: string; taskIds: string[] }[];
let transfers: MaterialTransferInput[];
const fakePlan = (input: MaterialTransferInput) => ({ id: `plan-${planTransport}`, receiptId: "receipt", file: input.file, source: {}, target: { objectKey: `owned/${input.file.id}`, storageProfileId: "aigc" } }) as unknown as MaterialTransferPlan;
function jobsWith(overrides: Partial<Parameters<typeof createDeseretIntegrationJobs>[0]> = {}) {
  return createDeseretIntegrationJobs({
    db: h.db, clock: () => now, reportDiagnostic: () => {},
    planTransfer: fakePlan,
    async transferFile(input) { transfers.push(input); return { ...input.file, objectKey: `aigc-staging/${input.file.id}` }; },
    sourceReceipt: async () => undefined,
    async registerIncoming(projectId, _jobId, file, _revision, _lease, _signal, taskIds) { registered.push({ project: projectId, file: file.id, taskIds: [...taskIds] }); },
    projectAuthority: async projectId => ({ sql: "EXISTS(SELECT 1 FROM projects WHERE id=?)", values: [projectId] }),
    withProject: (_projectId, work) => work(),
    deliver: async () => {},
    ...overrides,
  });
}
/** The harness's handoff row has a placeholder schedule; make it due now. */
function addMaterial(n: number) {
  h.addHandoffMaterial(guidanceImage(n));
  h.db.sqlite.prepare("UPDATE deseret_material_tasks SET next_attempt_at='2026-11-20T00:00:00.000Z' WHERE file_id=?").run(`guide-${n}`);
}
const task = (fileId: string) => h.db.sqlite.prepare("SELECT * FROM deseret_material_tasks WHERE file_id=?").get(fileId) as Row;
const target = (fileId: string) => JSON.parse(String(task(fileId).target_json ?? "{}")) as Row;
const failedEvents = () => Number((h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM deseret_outbox WHERE event_type='materials.failed'").get() as Row).n);
function setTarget(fileId: string, value: Row, state?: string) {
  h.db.sqlite.prepare(`UPDATE deseret_material_tasks SET target_json=?${state ? ",state=?" : ""} WHERE file_id=?`).run(...[JSON.stringify(value), ...(state ? [state] : []), fileId] as never[]);
}
function linkOtherProject() {
  h.db.sqlite.prepare("INSERT INTO deseret_project_links VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(OTHER_PROJECT, "db-project-2", SOURCE, 1, JSON.stringify({ project: { title: "Other" }, brief: {} }),
    JSON.stringify({ ...finalReviewState(), scenes: [], packages: [] }), JSON.stringify(["video-x"]), JSON.stringify(["task-x"]), 7, LEAD, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
  const file = guidanceImage(9);
  const id = createHash("sha256").update(JSON.stringify([OTHER_PROJECT, SOURCE, file.id])).digest("hex");
  h.db.sqlite.prepare("INSERT INTO deseret_material_tasks (id,project_id,source_revision,file_id,file_version,manifest_json,direction,package_id,target_json,state,attempts,last_error,lease_id,lease_expires_at,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'deseret_to_aigc',NULL,NULL,'pending',0,NULL,NULL,NULL,?,?,?)")
    .run(id, OTHER_PROJECT, SOURCE, file.id, file.version, JSON.stringify(file), "2026-11-20T00:00:00.000Z", "t", "t");
}

describe("relay job lanes: retry, changed sources, plans, cleanup and leases", () => {
  beforeEach(() => {
    h = createHarness({ ...finalReviewState(), materials: "waiting_transfer" } as DeseretIntegrationState);
    now = Date.parse("2026-11-20T09:00:01.000Z");
    planTransport = "deseret_relay";
    registered = [];
    transfers = [];
  });

  it("keeps transient relay and provider errors pending with bounded backoff and no materials.failed event", async () => {
    addMaterial(1);
    addMaterial(2);
    const errors: Record<string, unknown> = { "guide-1": Object.assign(new Error("busy"), { code: "TRANSFER_RETRY" }), "guide-2": Object.assign(new Error("5xx"), { $metadata: { httpStatusCode: 503 } }) };
    const jobs = jobsWith({ async transferFile(input) { throw errors[input.file.id]; } });
    const failures = await jobs.materialTick(new AbortController().signal);
    assert.deepEqual(failures.map(failure => (failure as Error & { code?: string }).code), ["TRANSFER_RETRY"]);
    assert.deepEqual([task("guide-1").state, task("guide-1").last_error, task("guide-1").next_attempt_at], ["pending", "TRANSFER_RETRY", new Date(now + 2000).toISOString()]);
    // The project's second task waited behind the first failure; a provider 503 is classified the same way.
    now += 1000;
    await jobs.materialTick(new AbortController().signal);
    assert.deepEqual([task("guide-2").state, task("guide-2").last_error], ["pending", "TRANSFER_RETRY"]);
    // Backoff doubles with attempts.
    now += 5000;
    await jobs.materialTick(new AbortController().signal);
    assert.deepEqual([task("guide-1").attempts, task("guide-1").next_attempt_at], [2, new Date(now + 4000).toISOString()]);
    await jobs.reconcile(PROJECT);
    assert.equal(failedEvents(), 0);
  });

  it("stops a changed source: no automatic or manual retry, cleanup aborts its recorded upload and keeps the code", async () => {
    addMaterial(1);
    addMaterial(2);
    const aborted: unknown[] = [];
    let attempts = 0;
    const jobs = jobsWith({
      async transferFile(input) {
        attempts++;
        if (input.file.id === "guide-2") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        await input.onMultipartCreated!("upload-changed", { etag: "old", versionId: "v1" });
        throw Object.assign(new Error("changed"), { code: "TRANSFER_SOURCE_CHANGED" });
      },
      async abortTransfer(input, plan) { aborted.push([input.multipartUploadId, plan.id]); },
    });
    await jobs.materialTick(new AbortController().signal);
    assert.deepEqual([task("guide-1").state, task("guide-1").last_error], ["waiting_config", "TRANSFER_SOURCE_CHANGED"]);
    assert.deepEqual([target("guide-1").peerUploadId, target("guide-1").sourcePin], ["upload-changed", { etag: "old", versionId: "v1" }]);
    now += 10 * 60_000;
    attempts = 0;
    await jobs.materialTick(new AbortController().signal);
    assert.equal(attempts, 1, "only the ordinary failure is retried automatically");
    // The manual retry restarts ordinary failures but leaves the changed source stopped.
    h.db.sqlite.prepare("UPDATE deseret_material_tasks SET state='failed' WHERE file_id='guide-2'").run();
    const lead = await h.service.workspace(LEAD, PROJECT);
    await h.service.command(LEAD, PROJECT, { requestId: "retry-relay", expectedRevision: lead.revision, action: "materials.retry", payload: {} });
    assert.equal(task("guide-2").state, "pending");
    assert.deepEqual([task("guide-1").state, task("guide-1").last_error], ["waiting_config", "TRANSFER_SOURCE_CHANGED"]);
    await jobs.cleanupTick(new AbortController().signal);
    assert.deepEqual(aborted, [["upload-changed", "plan-deseret_relay"]]);
    assert.deepEqual([task("guide-1").state, task("guide-1").last_error, target("guide-1").peerUploadId, target("guide-1").sourcePin], ["waiting_config", "TRANSFER_SOURCE_CHANGED", undefined, undefined]);
    await jobs.cleanupTick(new AbortController().signal);
    assert.equal(aborted.length, 1);
    // With only the changed source left, the lead is not offered a retry that would do nothing.
    h.db.sqlite.prepare("UPDATE deseret_material_tasks SET state='ready' WHERE file_id='guide-2'").run();
    editState(state => { state.materials = "waiting_transfer"; });
    assert.ok(!(await h.service.workspace(LEAD, PROJECT)).actions.includes("materials.retry"));
  });

  it("persists the source pin with the upload handle and resumes the interrupted upload with both", async () => {
    addMaterial(1);
    let first = true;
    const jobs = jobsWith({
      async transferFile(input) {
        transfers.push(input);
        if (first) { first = false; await input.onMultipartCreated!("upload-1", { etag: "e1", versionId: "v1" }); throw Object.assign(new Error("dropped"), { code: "TRANSFER_RETRY" }); }
        return { ...input.file, objectKey: "aigc-staging/guide-1" };
      },
    });
    await jobs.materialTick(new AbortController().signal);
    now += 3000;
    await jobs.materialTick(new AbortController().signal);
    assert.deepEqual([transfers[1].multipartUploadId, transfers[1].sourcePin], ["upload-1", { etag: "e1", versionId: "v1" }]);
    assert.equal(task("guide-1").state, "ready");
    assert.equal(target("guide-1").peerUploadId, "upload-1", "ready records keep their multipart identity");
  });

  it("replans a recorded plan that never started an upload, but never resumes a handle under another transport", async () => {
    addMaterial(1);
    addMaterial(2);
    planTransport = "server_copy";
    const oldPlan = (id: string) => fakePlan({ ...incoming(), file: guidanceImage(id === "guide-1" ? 1 : 2) });
    setTarget("guide-1", { plan: oldPlan("guide-1"), sourcePin: { etag: "stale" } });
    setTarget("guide-2", { plan: oldPlan("guide-2"), peerUploadId: "copy-upload" });
    planTransport = "deseret_relay";
    const jobs = jobsWith();
    await jobs.materialTick(new AbortController().signal);
    assert.deepEqual(transfers.map(input => [input.file.id, input.multipartUploadId, input.sourcePin]), [["guide-1", undefined, undefined]]);
    assert.equal(task("guide-1").state, "ready");
    assert.equal((target("guide-1").plan as Row).id, "plan-deseret_relay");
    assert.deepEqual([task("guide-2").state, task("guide-2").last_error, target("guide-2").peerUploadId, (target("guide-2").plan as Row).id],
      ["waiting_config", "TRANSFER_PLAN_MISMATCH", "copy-upload", "plan-server_copy"]);
  });

  it("runs two projects at a time, never two tasks of one project, and keeps per-task QA frame registration", async () => {
    linkOtherProject();
    // guide-1: issues on both scenes (task-1 and task-2); guide-2: task-2 only. Plus one handoff material elsewhere.
    const issue = (id: string, sceneId: string, images: number[]) => ({ id, role: "marketing", actorId: "mkt-3", sceneId, sceneVersion: 1, body: `Reason ${id}`, seconds: 2, endSeconds: 6, frames: images.map(n => ({ seconds: 3, file: guidanceImage(n) })) });
    const [envelope, raw] = concludedEnvelope({ actorId: "qa-reviewer-7", body: "Fix the listed issues.", sceneId: "final-task-1", issues: [issue("a", "final-task-1", [1]), issue("b", "final-task-2", [2]), issue("c", "final-task-2", [1])] });
    await h.service.receive(envelope, raw);
    const active = new Map<string, number>();
    let peak = 0, peakSameProject = 0;
    const jobs = jobsWith({
      materialConcurrency: 2,
      async transferFile(input) {
        active.set(input.projectId, (active.get(input.projectId) ?? 0) + 1);
        peak = Math.max(peak, [...active.values()].reduce((sum, value) => sum + value, 0));
        peakSameProject = Math.max(peakSameProject, ...active.values());
        await new Promise(resolve => setTimeout(resolve, 5));
        active.set(input.projectId, active.get(input.projectId)! - 1);
        return { ...input.file, objectKey: `aigc-staging/${input.file.id}` };
      },
    });
    for (let round = 0; round < 3; round++) await jobs.materialTick(new AbortController().signal);
    assert.equal(peak, 2);
    assert.equal(peakSameProject, 1);
    const scope = (file: string) => registered.filter(call => call.file === file).map(call => [call.project, call.taskIds]);
    assert.deepEqual(scope("guide-1"), [[PROJECT, ["task-1", "task-2"]]]);
    assert.deepEqual(scope("guide-2"), [[PROJECT, ["task-2"]]]);
    assert.deepEqual(scope("guide-9"), [[OTHER_PROJECT, ["task-x"]]]);
  });

  it("aborts the transfer when a lease renewal stalls beyond ten seconds", async t => {
    addMaterial(1);
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith("UPDATE deseret_material_tasks SET lease_expires_at=?")) return statement;
      const stalled = { ...statement, bind: () => stalled, run: () => new Promise<never>(() => {}) };
      return stalled as typeof statement;
    };
    const jobs = jobsWith({
      transferBudget: size => materialTransferBudget(size, "deseret_relay"),
      async transferFile(input) {
        started();
        await new Promise((_, reject) => input.signal!.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true }));
        throw new Error("unreachable");
      },
    });
    const tick = jobs.materialTick(new AbortController().signal);
    await running;
    t.mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(task("guide-1").state, "running");
    t.mock.timers.tick(10_000);
    const failures = await tick;
    assert.deepEqual(failures.map(failure => (failure as Error & { code?: string }).code), ["OPERATION_ABORTED"]);
    assert.deepEqual([task("guide-1").state, task("guide-1").lease_id], ["pending", null]);
  });

  it("cleans only visible projects' stopped uploads after their lease, rereading the handle after the claim", async () => {
    addMaterial(1);
    const plan = fakePlan({ ...incoming(), file: guidanceImage(1) });
    h.db.sqlite.prepare("UPDATE deseret_material_tasks SET lease_expires_at=? WHERE file_id='guide-1'").run(new Date(now + 60_000).toISOString());
    setTarget("guide-1", { plan, peerUploadId: "old-handle" }, "cancelled");
    const aborted: unknown[] = [];
    const jobs = jobsWith({
      async withProject(_projectId, work) { setTarget("guide-1", { plan, peerUploadId: "new-handle", marker: "kept" }, "cancelled"); return work(); },
      async abortTransfer(input) { aborted.push(input.multipartUploadId); },
    });
    assert.deepEqual(await jobs.cleanupTick(new AbortController().signal), []);
    assert.deepEqual(aborted, [], "an unexpired lease is left alone");
    now += 60_001;
    h.db.sqlite.prepare("UPDATE projects SET deleted_at='2026-11-20T09:00:00.000Z' WHERE id=?").run(PROJECT);
    assert.deepEqual(await jobs.cleanupTick(new AbortController().signal), []);
    assert.deepEqual(aborted, [], "deleted projects are left to business deletion");
    h.db.sqlite.prepare("UPDATE projects SET deleted_at=NULL WHERE id=?").run(PROJECT);
    await jobs.cleanupTick(new AbortController().signal);
    assert.deepEqual(aborted, ["new-handle"]);
    assert.deepEqual([task("guide-1").state, target("guide-1").peerUploadId, target("guide-1").marker], ["cancelled", undefined, "kept"]);
  });
});

function editState(change: (state: DeseretIntegrationState) => void) {
  const state = h.state();
  change(state);
  h.db.sqlite.prepare("UPDATE deseret_project_links SET state_json=? WHERE id=?").run(JSON.stringify(state), PROJECT);
}
