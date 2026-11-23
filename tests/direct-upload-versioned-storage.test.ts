// Direct uploads on a Wasabi bucket with versioning Enabled: version-pinned promotion, persisted version receipts,
// exact-version cleanup, ambiguous storage responses, foreign versions of the same key and records written before
// versioning. The bucket below is an in-memory model of the S3 behaviour the service relies on; no network access.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { contractDatabase } from "./support/contract-database";
import { createDirectUploadService, sessionAssets, parseDirectUpload } from "../db/direct-upload-service";
import { verifiedUpload } from "../runtime/verified-upload";
import type { Database, DatabaseResult, DatabaseStatement } from "../db/database";
import type { DirectStorageMode, WasabiBucket } from "../runtime/wasabi";

type Row = Record<string, unknown>;
type Version = { versionId: string; owner?: string; size: number; etag: string; checksum?: string; marker?: boolean };
type Fault = "ambiguous" | "no-version";

/** contractDatabase, with RETURNING rows also returned from batched statements (as MySQL's adapter does). */
function testDatabase() {
  const base = contractDatabase(), sqlite = base.sqlite;
  const statement = (sql: string, values: unknown[] = []): DatabaseStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>(column?: string) { const row = sqlite.prepare(sql).get(...values as never[]) as Row | undefined; return (row ? (column ? row[column] : row) : null) as T | null; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[], success: true, meta: { changes: 0 } } as DatabaseResult<T>; },
    async run<T>() {
      if (/\bRETURNING\b/i.test(sql)) { const rows = sqlite.prepare(sql).all(...values as never[]) as T[]; return { results: rows, success: true, meta: { changes: rows.length } } as DatabaseResult<T>; }
      return { results: [], success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } } as DatabaseResult<T>;
    },
    async raw<T>() { return (sqlite.prepare(sql).all(...values as never[]) as Row[]).map(row => Object.values(row)) as T[]; },
  });
  const db: Database = {
    prepare: sql => statement(sql),
    async batch<T>(statements: DatabaseStatement[]) {
      sqlite.exec("BEGIN");
      try { const results: DatabaseResult<T>[] = []; for (const item of statements) results.push(await item.run<T>()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    async exec(sql: string) { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  return Object.assign(db, { sqlite, insert: base.insert });
}

const s3Error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const timeout = () => Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });

/** In-memory S3 semantics: Enabled keeps every version (key deletes add a delete marker); unversioned overwrites. */
class FakeBucket {
  status: "unversioned" | "enabled" | "suspended";
  objects = new Map<string, Version[]>();
  uploads = new Map<string, { key: string; owner?: string; parts: Map<number, { size: number; sha256: string }> }>();
  log: string[] = [];
  faults: Partial<Record<"complete" | "copy" | "deleteVersion", Fault>> = {};
  private sequence = 0;
  constructor(status: FakeBucket["status"]) { this.status = status; }
  private next(prefix: string) { return `${prefix}${++this.sequence}`; }
  private fault(name: keyof FakeBucket["faults"]) { const value = this.faults[name]; delete this.faults[name]; return value; }
  write(key: string, value: Omit<Version, "versionId">) {
    const version = { ...value, versionId: this.status === "enabled" ? this.next("v") : "null" };
    this.objects.set(key, this.status === "enabled" ? [...(this.objects.get(key) ?? []), version] : [version]);
    return version;
  }
  /** A write by some other system to the same key. */
  foreign(key: string, size = 7) { return this.write(key, { owner: "someone-else", size, etag: this.next("foreign-") }); }
  current(key: string) { const last = this.objects.get(key)?.at(-1); return last && !last.marker ? last : undefined; }
  versions(key: string) { return (this.objects.get(key) ?? []).filter(version => !version.marker); }
  markers(key: string) { return (this.objects.get(key) ?? []).filter(version => version.marker).length; }
  uploadPart(key: string, handle: string, number: number, size: number, sha256: string) {
    const upload = this.uploads.get(handle); assert.ok(upload && upload.key === key, "signed part targets a live upload");
    upload.parts.set(number, { size, sha256 });
  }

  async directStorageMode(): Promise<DirectStorageMode> {
    this.log.push("mode");
    if (this.status === "suspended") throw Error("DIRECT_NATIVE_VERSIONING_UNSUPPORTED");
    return this.status;
  }
  async assertDirectReady() { if (await this.directStorageMode() !== "unversioned") throw Error("DIRECT_NATIVE_VERSIONING_UNSUPPORTED"); }
  async head(key: string, options?: { checksum?: boolean; versionId?: string }) {
    this.log.push(`head:${key}${options?.versionId ? `@${options.versionId}` : ""}`);
    const found = options?.versionId ? this.objects.get(key)?.find(version => version.versionId === options.versionId && !version.marker) : this.current(key);
    if (!found) return null;
    return { size: found.size, etag: found.etag, ...(found.owner ? { uploadOwner: found.owner } : {}), ...(this.status === "enabled" ? { versionId: found.versionId } : {}),
      ...(options?.checksum && found.checksum ? { checksumSha256: found.checksum, checksumType: "COMPOSITE" } : {}) };
  }
  async beginMultipart(key: string, _type: string, owner?: string, mode?: DirectStorageMode) {
    if ((mode ?? "unversioned") !== await this.directStorageMode()) throw Error(mode ? "DIRECT_STORAGE_MODE_CHANGED" : "DIRECT_NATIVE_VERSIONING_UNSUPPORTED");
    const pending = await this.findMultipart(key); if (pending.length === 1) return pending[0];
    const handle = this.next("upload-"); this.uploads.set(handle, { key, owner, parts: new Map() }); return handle;
  }
  async findMultipart(key: string) { return [...this.uploads].filter(([, upload]) => upload.key === key).map(([handle]) => handle); }
  async signPart(key: string, handle: string, part: number) { return `https://storage.invalid/${key}?upload=${handle}&part=${part}`; }
  async parts(_key: string, handle: string) {
    const upload = this.uploads.get(handle); if (!upload) throw s3Error("NoSuchUpload", 404);
    return [...upload.parts].sort(([a], [b]) => a - b).map(([number, part]) => ({ number, size: part.size, etag: `part-${number}`, sha256: part.sha256 }));
  }
  async completeMultipart(key: string, handle: string, parts: { number: number; sha256: string }[]) {
    this.log.push(`complete:${key}`);
    const upload = this.uploads.get(handle); if (!upload) throw s3Error("NoSuchUpload", 404);
    this.uploads.delete(handle);
    const digests = Buffer.concat(parts.map(part => Buffer.from(part.sha256, "base64")));
    const size = [...upload.parts.values()].reduce((sum, part) => sum + part.size, 0);
    const version = this.write(key, { owner: upload.owner, size, etag: this.next("etag-"), checksum: `${createHash("sha256").update(digests).digest("base64")}-${parts.length}` });
    if (this.fault("complete") === "ambiguous") throw timeout();
    return { ETag: `"${version.etag}"`, ...(this.status === "enabled" ? { VersionId: version.versionId } : {}) };
  }
  async abortMultipart(key: string, handle: string) {
    this.log.push(`abort:${key}`);
    if (!this.uploads.delete(handle)) throw s3Error("NoSuchUpload", 404);
  }
  /** The receipt protocol of WasabiBucket.copy: a saved multipart receipt, CopySourceIfMatch and IfNoneMatch:'*'. */
  async copy(source: string, destination: string, etag: string, _type: string | undefined, owner: string | undefined, createOnly: boolean,
    receipt: { handle?: string; created: (handle: string) => Promise<void>; assertCurrent: () => Promise<void>; sourceVersionId?: string }) {
    assert.equal(createOnly, true);
    this.log.push(`copy:${source}${receipt.sourceVersionId ? `@${receipt.sourceVersionId}` : ""}->${destination}`);
    await receipt.assertCurrent();
    let handle = receipt.handle;
    if (!handle) { handle = this.next("receipt-"); this.uploads.set(handle, { key: destination, owner, parts: new Map() }); await receipt.created(handle); }
    if (!this.uploads.has(handle)) throw s3Error("NoSuchUpload", 404);
    const from = receipt.sourceVersionId ? this.versions(source).find(version => version.versionId === receipt.sourceVersionId) : this.current(source);
    if (!from || from.etag !== etag) throw s3Error("PreconditionFailed", 412);
    if (this.current(destination)) throw s3Error("PreconditionFailed", 412);
    this.uploads.delete(handle);
    const version = this.write(destination, { owner, size: from.size, etag: this.next("copy-") });
    const fault = this.fault("copy");
    if (fault === "ambiguous") throw timeout();
    return { etag: version.etag, ...(this.status === "enabled" && fault !== "no-version" ? { versionId: version.versionId } : {}) };
  }
  async delete(key: string) {
    this.log.push(`delete:${key}`);
    if (this.status === "enabled") this.objects.set(key, [...(this.objects.get(key) ?? []), { versionId: this.next("marker-"), size: 0, etag: "", marker: true }]);
    else this.objects.delete(key);
  }
  async deleteVersion(key: string, versionId: string) {
    this.log.push(`deleteVersion:${key}@${versionId}`);
    this.objects.set(key, (this.objects.get(key) ?? []).filter(version => version.versionId !== versionId));
    if (this.fault("deleteVersion") === "ambiguous") throw timeout();
  }
  async listVersions(key: string) {
    this.log.push(`listVersions:${key}`);
    return (this.objects.get(key) ?? []).map(version => ({ versionId: version.versionId, deleteMarker: Boolean(version.marker) }));
  }
}

const actor = "editor@example.test";
const body = Buffer.from("direct upload body for a versioned bucket");
const partDigest = createHash("sha256").update(body).digest("base64");
const destinationOf = (id: string) => `files/${id}/clip.mp4`;
const temporaryOf = (id: string) => `direct-upload-temporary/${id}/file`;

function setup(status: FakeBucket["status"]) {
  const db = testDatabase(), bucket = new FakeBucket(status);
  const behaviour = { failRegistration: false, destination: destinationOf };
  const service = createDirectUploadService({
    db, bucket: bucket as unknown as WasabiBucket, scopes: async () => [],
    async dispatch(_actor, input, file, _thumbnail, execution) {
      if (execution.prepareOnly) return {};
      const record = verifiedUpload(file);
      assert.ok(record?.promote, "the service hands over a verified, promotable upload");
      const key = behaviour.destination(input.id), stored = await record.promote(key, file.type);
      if (behaviour.failRegistration) throw Object.assign(new Error("Registration failed"), { code: "TEST_REGISTRATION_FAILED" });
      await execution.commit!([db.prepare("INSERT INTO aigc_storage_objects(id,provider,bucket_name,region_name,object_key,etag,created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(randomUUID(), "wasabi", "test-bucket", "ap-southeast-1", key, stored.etag, new Date().toISOString())], { key });
      return { key };
    },
  });
  const session = (id: string) => db.sqlite.prepare("SELECT * FROM direct_upload_sessions WHERE id=?").get(id) as Row & { state: string; assets_json: string; cleaned_at: string | null };
  const assets = (id: string) => JSON.parse(session(id).assets_json) as { handle: string; etag?: string; versioning?: string; versionId?: string; destinations?: { key: string; confirmed: boolean; handle?: string; versionId?: string }[] }[];
  /** Reserve, sign the single part and let the browser upload it. */
  async function transmit(id = randomUUID()) {
    await service.create(actor, { id, endpoint: "/api/files", fields: { languageProjectId: "task-1" }, file: { name: "clip.mp4", type: "video/mp4", size: body.length, sha256: createHash("sha256").update(body).digest("hex") } });
    await service.part(actor, id, "file", 1, partDigest);
    bucket.uploadPart(temporaryOf(id), assets(id)[0].handle, 1, body.length, partDigest);
    return id;
  }
  /** Expire the reservation so the periodic cleaner selects it. */
  const expire = (id: string) => db.sqlite.prepare("UPDATE direct_upload_sessions SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), id);
  return { db, bucket, service, behaviour, session, assets, transmit, expire };
}

const rejects = (promise: Promise<unknown>, expected: { code?: string; status?: number; name?: string }) =>
  assert.rejects(promise, (error: { code?: string; status?: number; name?: string }) => {
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key as keyof typeof error], value, `${key} of ${String((error as Error).message)}`);
    return true;
  });

describe("direct uploads on a bucket without versioning keep their behaviour", () => {
  test("completion copies by key alone and cleanup deletes by key", async () => {
    const { bucket, service, transmit, assets, session } = setup("unversioned");
    const id = await transmit();
    assert.equal((await service.complete(actor, id)).state, "ready");
    const [asset] = assets(id);
    assert.equal(asset.versioning, undefined); assert.equal(asset.versionId, undefined);
    assert.deepEqual(asset.destinations, [{ key: destinationOf(id), confirmed: true, copyProtocol: "multipart-receipt-v1", handle: asset.destinations![0].handle }]);
    assert.ok(bucket.log.includes(`copy:${temporaryOf(id)}->${destinationOf(id)}`), "no version pin on an unversioned bucket");
    assert.deepEqual(await service.cleanup(), { cleaned: [id], deferred: [] });
    assert.ok(bucket.log.includes(`delete:${temporaryOf(id)}`));
    assert.ok(!bucket.log.some(entry => entry.startsWith("deleteVersion:") || entry.startsWith("listVersions:")));
    assert.ok(bucket.current(destinationOf(id)), "the registered copy is kept");
    assert.ok(session(id).cleaned_at);
  });
});

describe("direct uploads on a bucket with versioning Enabled", () => {
  test("promotion is pinned to the recorded source version and every owned version is persisted", async () => {
    const { bucket, service, transmit, assets } = setup("enabled");
    const id = await transmit();
    assert.equal(assets(id)[0].versioning, "enabled-v1", "the reservation records versioned storage with its handle");
    assert.equal((await service.complete(actor, id)).state, "ready");
    const [asset] = assets(id), [temporary] = bucket.versions(temporaryOf(id)), [copy] = bucket.versions(destinationOf(id));
    assert.equal(asset.versionId, temporary.versionId);
    assert.equal(asset.destinations![0].versionId, copy.versionId);
    assert.equal(asset.destinations![0].confirmed, true);
    assert.ok(bucket.log.includes(`copy:${temporaryOf(id)}@${temporary.versionId}->${destinationOf(id)}`), "the copy names the source version");
    assert.ok(bucket.log.includes(`head:${temporaryOf(id)}@${temporary.versionId}`), "checksum verification reads the recorded version");
  });

  test("repeated completion of a ready upload is answered without storage work", async () => {
    const { bucket, service, transmit } = setup("enabled");
    const id = await transmit();
    await service.complete(actor, id);
    const before = bucket.log.length;
    assert.equal((await service.complete(actor, id)).state, "ready");
    assert.equal((await service.complete(actor, id)).state, "ready");
    assert.equal(bucket.log.length, before);
    assert.equal(bucket.versions(destinationOf(id)).length, 1);
  });

  test("an ambiguous temporary completion is recovered by the session's own current version", async () => {
    const { bucket, service, transmit, assets } = setup("enabled");
    const id = await transmit();
    bucket.faults.complete = "ambiguous";
    assert.equal((await service.complete(actor, id)).state, "ready");
    const [temporary] = bucket.versions(temporaryOf(id));
    assert.equal(bucket.versions(temporaryOf(id)).length, 1);
    assert.equal(assets(id)[0].versionId, temporary.versionId);
  });

  test("an ambiguous temporary completion followed by a foreign version fails closed; cancel removes only the session's version", async () => {
    const { bucket, service, transmit, assets, session } = setup("enabled");
    const id = await transmit();
    bucket.faults.complete = "ambiguous";
    // Another writer lands on the same key after the lost response, so the current version is not the session's.
    const original = bucket.completeMultipart.bind(bucket);
    bucket.completeMultipart = async (...args) => { try { return await original(...args); } finally { bucket.foreign(temporaryOf(id), body.length); } };
    await rejects(service.complete(actor, id), { status: 409 });
    assert.equal(assets(id)[0].versionId, undefined, "an unproven version is never recorded");
    assert.equal(bucket.log.filter(entry => entry.startsWith("copy:")).length, 0, "nothing is promoted");
    const [own, foreign] = bucket.versions(temporaryOf(id));
    assert.deepEqual(await service.cancel(actor, id), { ok: true });
    assert.equal(session(id).state, "cancelled");
    assert.deepEqual(bucket.versions(temporaryOf(id)).map(version => version.versionId), [foreign.versionId], "the foreign version is untouched");
    assert.ok(bucket.log.includes(`deleteVersion:${temporaryOf(id)}@${own.versionId}`));
    assert.ok(!bucket.log.some(entry => entry.startsWith("delete:")), "no key-level delete, so no delete marker");
    assert.equal(bucket.markers(temporaryOf(id)), 0);
  });

  test("an ambiguous copy response is confirmed on retry without a second copy", async () => {
    const { bucket, service, transmit, assets } = setup("enabled");
    const id = await transmit();
    bucket.faults.copy = "ambiguous";
    await rejects(service.complete(actor, id), { code: "DIRECT_STORAGE_TIMEOUT" });
    const pending = assets(id)[0].destinations![0];
    assert.equal(pending.confirmed, false); assert.ok(pending.handle, "the receipt is kept for the retry");
    assert.equal((await service.complete(actor, id)).state, "ready");
    const copies = bucket.versions(destinationOf(id));
    assert.equal(copies.length, 1);
    assert.equal(assets(id)[0].destinations![0].versionId, copies[0].versionId);
    assert.equal(bucket.log.filter(entry => entry.startsWith("copy:")).length, 1);
  });

  test("a copy response without a version ID is resolved to the session's current version", async () => {
    const { bucket, service, transmit, assets } = setup("enabled");
    const id = await transmit();
    bucket.faults.copy = "no-version";
    assert.equal((await service.complete(actor, id)).state, "ready");
    assert.equal(assets(id)[0].destinations![0].versionId, bucket.versions(destinationOf(id))[0].versionId);
  });

  test("a foreign current version of the destination is never overwritten or deleted", async () => {
    const { bucket, service, transmit, assets } = setup("enabled");
    const id = await transmit();
    const foreign = bucket.foreign(destinationOf(id));
    await rejects(service.complete(actor, id), { name: "PreconditionFailed" });
    assert.deepEqual(bucket.versions(destinationOf(id)), [foreign]);
    assert.deepEqual(assets(id)[0].destinations ?? [], [], "the aborted receipt is forgotten");
    assert.equal(bucket.uploads.size, 0, "the receipt upload is aborted");
  });

  test("a recorded copy that a foreign version replaced is not registered", async () => {
    const { bucket, service, behaviour, transmit } = setup("enabled");
    const id = await transmit();
    behaviour.failRegistration = true;
    await rejects(service.complete(actor, id), { code: "TEST_REGISTRATION_FAILED" });
    bucket.foreign(destinationOf(id), body.length);
    behaviour.failRegistration = false;
    await rejects(service.complete(actor, id), { code: "UPLOAD_NAME_IN_USE" });
  });

  test("cleanup deletes the session's exact versions and leaves foreign versions and delete markers", async () => {
    const { bucket, service, behaviour, transmit, assets, session } = setup("enabled");
    const id = await transmit();
    // A foreign version exists below a delete marker, so the create-only copy may proceed.
    const foreign = bucket.foreign(destinationOf(id)); await bucket.delete(destinationOf(id));
    behaviour.failRegistration = true;
    await rejects(service.complete(actor, id), { code: "TEST_REGISTRATION_FAILED" });
    const recorded = assets(id)[0].destinations![0];
    assert.equal(recorded.confirmed, true); assert.ok(recorded.versionId);
    assert.deepEqual(await service.cancel(actor, id), { ok: true });
    assert.deepEqual(await service.cleanup(), { cleaned: [id], deferred: [] });
    assert.ok(session(id).cleaned_at);
    assert.deepEqual(bucket.versions(destinationOf(id)), [foreign], "only the unregistered copy is removed");
    assert.equal(bucket.markers(destinationOf(id)), 1, "the existing delete marker is untouched and none is added");
    assert.deepEqual(bucket.versions(temporaryOf(id)), []);
    assert.ok(bucket.log.includes(`deleteVersion:${destinationOf(id)}@${recorded.versionId}`));
    assert.ok(!bucket.log.some(entry => entry.startsWith(`delete:${temporaryOf(id)}`)));
  });

  test("a foreign version on the temporary key never replaces the recorded source", async () => {
    const { bucket, service, behaviour, transmit, assets } = setup("enabled");
    const id = await transmit();
    behaviour.failRegistration = true;
    await rejects(service.complete(actor, id), { code: "TEST_REGISTRATION_FAILED" });
    const recorded = assets(id)[0].versionId!;
    const foreign = bucket.foreign(temporaryOf(id), body.length);
    // The retry promotes to another destination, so it must verify and copy the recorded version, not the current one.
    behaviour.failRegistration = false; behaviour.destination = key => `files/${key}/renamed.mp4`;
    assert.equal((await service.complete(actor, id)).state, "ready");
    assert.ok(bucket.log.includes(`head:${temporaryOf(id)}@${recorded}`));
    assert.ok(bucket.log.includes(`copy:${temporaryOf(id)}@${recorded}->files/${id}/renamed.mp4`));
    assert.deepEqual(await service.cleanup(), { cleaned: [id], deferred: [] });
    assert.deepEqual(bucket.versions(temporaryOf(id)), [foreign], "only the session's temporary version is removed");
    assert.deepEqual(bucket.versions(destinationOf(id)), [], "the unregistered first copy is removed");
    assert.equal(bucket.versions(`files/${id}/renamed.mp4`).length, 1, "the registered copy is kept");
  });

  test("cleanup of a ready upload keeps the registered copy and deletes the temporary version", async () => {
    const { bucket, service, transmit, session } = setup("enabled");
    const id = await transmit();
    await service.complete(actor, id);
    const [copy] = bucket.versions(destinationOf(id));
    assert.deepEqual(await service.cleanup(), { cleaned: [id], deferred: [] });
    assert.equal(session(id).state, "ready");
    assert.deepEqual(bucket.versions(destinationOf(id)), [copy]);
    assert.deepEqual(bucket.objects.get(temporaryOf(id)), [], "no version and no delete marker remain");
  });

  test("cleanup after an ambiguous copy and a foreign overwrite removes only the session's version", async () => {
    const { bucket, service, transmit, assets, expire, session } = setup("enabled");
    const id = await transmit();
    bucket.faults.copy = "ambiguous";
    await rejects(service.complete(actor, id), { code: "DIRECT_STORAGE_TIMEOUT" });
    const foreign = bucket.foreign(destinationOf(id), body.length);
    assert.equal(assets(id)[0].destinations![0].confirmed, false);
    expire(id);
    assert.deepEqual(await service.cleanup(), { cleaned: [id], deferred: [] });
    assert.equal(session(id).state, "expired");
    assert.deepEqual(bucket.versions(destinationOf(id)), [foreign]);
    assert.deepEqual(bucket.versions(temporaryOf(id)), []);
  });

  test("repeated and interrupted cancellation are safe", async () => {
    const { bucket, service, behaviour, transmit, session } = setup("enabled");
    const id = await transmit();
    behaviour.failRegistration = true;
    await rejects(service.complete(actor, id), { code: "TEST_REGISTRATION_FAILED" });
    // The version is deleted but the response is lost.
    bucket.faults.deleteVersion = "ambiguous";
    await rejects(service.cancel(actor, id), { name: "TimeoutError" });
    assert.notEqual(session(id).state, "cancelled");
    assert.deepEqual(await service.cancel(actor, id), { ok: true });
    await rejects(service.cancel(actor, id), { code: "UPLOAD_UNAVAILABLE" });
    assert.deepEqual(bucket.versions(temporaryOf(id)), []);
    assert.equal(bucket.markers(temporaryOf(id)), 0);
  });

  test("cancelling before any part is complete aborts the multipart upload only", async () => {
    const { bucket, service, transmit } = setup("enabled");
    const id = await transmit();
    assert.deepEqual(await service.cancel(actor, id), { ok: true });
    assert.equal(bucket.uploads.size, 0);
    assert.ok(!bucket.log.some(entry => entry.startsWith("delete")));
  });
});

describe("records without version receipts fail closed on a versioned bucket", () => {
  async function legacy() {
    const context = setup("unversioned");
    const id = await context.transmit();
    context.bucket.status = "enabled";
    return { ...context, id };
  }
  test("completion, signing and cancellation refuse an upload started before versioning", async () => {
    const { bucket, service, id } = await legacy();
    await rejects(service.complete(actor, id), { code: "UPLOAD_RECONCILIATION_REQUIRED" });
    await rejects(service.part(actor, id, "file", 1, partDigest), { code: "UPLOAD_RECONCILIATION_REQUIRED" });
    await rejects(service.cancel(actor, id), { code: "UPLOAD_RECONCILIATION_REQUIRED" });
    assert.ok(!bucket.log.some(entry => /^(copy|complete|abort|delete)/.test(entry)));
  });
  test("cleanup defers an old receipt without touching storage", async () => {
    const { bucket, service, id, expire, session } = await legacy();
    expire(id);
    assert.deepEqual(await service.cleanup(), { cleaned: [], deferred: [id] });
    assert.equal(session(id).cleaned_at, null);
    assert.ok(!bucket.log.some(entry => /^(abort|delete|listVersions)/.test(entry)));
  });
  test("a completed old receipt is not cleaned by key", async () => {
    const context = setup("unversioned");
    const id = await context.transmit();
    context.behaviour.failRegistration = true;
    await rejects(context.service.complete(actor, id), { code: "TEST_REGISTRATION_FAILED" });
    context.bucket.status = "enabled";
    context.expire(id);
    assert.deepEqual(await context.service.cleanup(), { cleaned: [], deferred: [id] });
    assert.ok(context.bucket.current(temporaryOf(id)) && context.bucket.current(destinationOf(id)));
  });
  test("a versioned record is not handled as unversioned", async () => {
    const { bucket, service, transmit } = setup("enabled");
    const id = await transmit();
    bucket.status = "unversioned";
    await rejects(service.complete(actor, id), { code: "UPLOAD_RECONCILIATION_REQUIRED" });
  });
  test("a bucket with versioning Suspended is refused before any storage write", async () => {
    const { bucket, service, transmit } = setup("suspended");
    await rejects(transmit(), { code: "DIRECT_STORAGE_VERSIONING", status: 503 });
    assert.equal(bucket.uploads.size, 0);
  });
});

describe("persisted version receipts are validated", () => {
  const id = randomUUID();
  const input = parseDirectUpload({ id, endpoint: "/api/files", fields: {}, file: { name: "clip.mp4", type: "video/mp4", size: body.length, sha256: "a".repeat(64) } });
  const asset = (extra: object) => JSON.stringify([{ slot: "file", key: temporaryOf(id), name: "clip.mp4", type: "video/mp4", size: body.length, sha256: "a".repeat(64), handle: "upload-1", parts: {}, ...extra }]);
  test("consistent receipts are accepted", () => {
    assert.doesNotThrow(() => sessionAssets({ id, assets_json: asset({ versioning: "enabled-v1", etag: "e", versionId: "v1", destinations: [{ key: "files/a", confirmed: true, versionId: "v2" }] }) }, input));
    assert.doesNotThrow(() => sessionAssets({ id, assets_json: asset({ etag: "e", destinations: [{ key: "files/a", confirmed: true }] }) }, input));
  });
  for (const [name, extra] of [
    ["a version ID without versioned storage", { etag: "e", versionId: "v1" }],
    ["a versioned temporary file without its version", { versioning: "enabled-v1", etag: "e" }],
    ["the literal null version", { versioning: "enabled-v1", etag: "e", versionId: "null" }],
    ["a confirmed versioned copy without its version", { versioning: "enabled-v1", etag: "e", versionId: "v1", destinations: [{ key: "files/a", confirmed: true }] }],
    ["an unknown storage marker", { versioning: "suspended" }],
  ] as const) test(`rejects ${name}`, () => assert.throws(() => sessionAssets({ id, assets_json: asset(extra) }, input), /Invalid persisted version receipt/));
});
