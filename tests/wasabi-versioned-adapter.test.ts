// The Wasabi adapter's versioning contract, checked against the S3 commands it sends. No network access: the S3
// client is replaced with a recorder after construction.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WasabiBucket } from "../runtime/wasabi";

type Sent = { name: string; input: Record<string, unknown> };
const environment = {
  NODE_ENV: "test", LIFEWOOD_ENV: "local", MYSQL_DATABASE: "lifewood_aigc", MYSQL_HOST: "127.0.0.1", MYSQL_USER: "lifewood", MYSQL_PASSWORD: "unused",
  WASABI_BUCKET: "local-aigc", WASABI_PREFIX: "lifewood-local/", WASABI_REGION: "ap-southeast-1", WASABI_ENDPOINT: "https://s3.ap-southeast-1.wasabisys.com",
  WASABI_ACCESS_KEY_ID: "unused", WASABI_SECRET_ACCESS_KEY: "unused",
} as NodeJS.ProcessEnv;

function bucketWith(reply: (command: Sent) => unknown) {
  const bucket = new WasabiBucket(environment), sent: Sent[] = [];
  Object.assign(bucket as unknown as { client: unknown }, { client: { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const entry = { name: command.constructor.name, input: command.input }; sent.push(entry);
    const value = reply(entry); if (value instanceof Error) throw value; return value;
  } } });
  return { bucket, sent };
}
const versioning = (Status?: string) => (command: Sent) => command.name === "GetBucketVersioningCommand" ? (Status ? { Status } : {}) : {};

describe("bucket versioning mode", () => {
  test("unversioned and Enabled are supported; Suspended is refused", async () => {
    assert.equal(await bucketWith(versioning()).bucket.directStorageMode(), "unversioned");
    assert.equal(await bucketWith(versioning("Enabled")).bucket.directStorageMode(), "enabled");
    await assert.rejects(bucketWith(versioning("Suspended")).bucket.directStorageMode(), /DIRECT_NATIVE_VERSIONING_UNSUPPORTED/);
  });
  test("callers that delete by key still require a bucket without versioning", async () => {
    await assert.doesNotReject(bucketWith(versioning()).bucket.assertDirectReady());
    await assert.rejects(bucketWith(versioning("Enabled")).bucket.assertDirectReady(), /DIRECT_NATIVE_VERSIONING_UNSUPPORTED/);
  });
  test("the mode is cached briefly and a failed lookup is not cached", async () => {
    let calls = 0, fail = true;
    const { bucket } = bucketWith(command => { if (command.name !== "GetBucketVersioningCommand") return {}; calls++; return fail ? new Error("network") : { Status: "Enabled" }; });
    await assert.rejects(bucket.directStorageMode(), /network/);
    await new Promise(resolve => setImmediate(resolve));
    fail = false;
    assert.equal(await bucket.directStorageMode(), "enabled");
    assert.equal(await bucket.directStorageMode(), "enabled");
    assert.equal(calls, 2);
  });
  test("a multipart upload starts only in the mode the caller recorded", async () => {
    const enabled = bucketWith(command => command.name === "GetBucketVersioningCommand" ? { Status: "Enabled" } : command.name === "ListMultipartUploadsCommand" ? { Uploads: [] } : { UploadId: "u-1" });
    assert.equal(await enabled.bucket.beginMultipart("direct-upload-temporary/a/file", "video/mp4", "a", "enabled"), "u-1");
    await assert.rejects(enabled.bucket.beginMultipart("direct-upload-temporary/a/file", "video/mp4", "a", "unversioned"), /DIRECT_STORAGE_MODE_CHANGED/);
    await assert.rejects(enabled.bucket.beginMultipart("direct-upload-temporary/a/file", "video/mp4", "a"), /DIRECT_NATIVE_VERSIONING_UNSUPPORTED/);
  });
});

describe("version-pinned operations", () => {
  const receipt = (sourceVersionId?: string) => ({ created: async () => {}, assertCurrent: async () => {}, ...(sourceVersionId ? { sourceVersionId } : {}) });
  const copyReplies = (command: Sent) => command.name === "CreateMultipartUploadCommand" ? { UploadId: "receipt-1" } : command.name === "UploadPartCopyCommand" ? { CopyPartResult: { ETag: '"p"' } } : command.name === "CompleteMultipartUploadCommand" ? { ETag: '"copy-etag"', VersionId: "dest-v1" } : {};

  test("a versioned copy names the source version, keeps both conditions and returns the new version", async () => {
    const { bucket, sent } = bucketWith(copyReplies);
    assert.deepEqual(await bucket.copy("direct-upload-temporary/a/file", "files/a b.mp4", "src-etag", "video/mp4", "a", true, receipt("src v/1")), { etag: "copy-etag", versionId: "dest-v1" });
    const part = sent.find(command => command.name === "UploadPartCopyCommand")!, complete = sent.find(command => command.name === "CompleteMultipartUploadCommand")!;
    assert.equal(part.input.CopySource, "local-aigc/lifewood-local/direct-upload-temporary/a/file?versionId=src%20v%2F1");
    assert.equal(part.input.CopySourceIfMatch, '"src-etag"');
    assert.equal(complete.input.IfNoneMatch, "*");
  });
  test("an unversioned copy is unchanged", async () => {
    const { bucket, sent } = bucketWith(command => command.name === "CompleteMultipartUploadCommand" ? { ETag: '"copy-etag"' } : copyReplies(command));
    assert.deepEqual(await bucket.copy("direct-upload-temporary/a/file", "files/a.mp4", "src-etag", "video/mp4", "a", true, receipt()), { etag: "copy-etag" });
    assert.equal(sent.find(command => command.name === "UploadPartCopyCommand")!.input.CopySource, "local-aigc/lifewood-local/direct-upload-temporary/a/file");
  });
  test("an invalid source version is refused before any request", async () => {
    const { bucket, sent } = bucketWith(copyReplies);
    await assert.rejects(bucket.copy("a", "b", "e", undefined, "o", true, receipt("null")), /Invalid object version/);
    assert.equal(sent.length, 0);
  });
  test("HEAD reads an exact version and reports it", async () => {
    const { bucket, sent } = bucketWith(() => ({ ContentLength: 4, ETag: '"e"', VersionId: "v9", Metadata: { "lifewood-upload-session": "a" } }));
    assert.deepEqual(await bucket.head("files/a.mp4", { versionId: "v9" }), { size: 4, etag: "e", uploadOwner: "a", versionId: "v9" });
    assert.equal(sent[0].input.VersionId, "v9");
    const missing = bucketWith(() => Object.assign(new Error("NoSuchVersion"), { $metadata: { httpStatusCode: 404 } }));
    assert.equal(await missing.bucket.head("files/a.mp4", { versionId: "gone" }), null);
  });
  test("version deletion always names one exact version", async () => {
    const { bucket, sent } = bucketWith(() => ({}));
    await bucket.deleteVersion("files/a.mp4", "v9");
    assert.deepEqual(sent, [{ name: "DeleteObjectCommand", input: { Bucket: "local-aigc", Key: "lifewood-local/files/a.mp4", VersionId: "v9" } }]);
    for (const invalid of ["", "null"]) await assert.rejects(bucket.deleteVersion("files/a.mp4", invalid), /Invalid object version/);
    assert.equal(sent.length, 1);
  });
});

describe("exact-key version lookup", () => {
  test("returns only the exact key, stops at a longer key and never deletes", async () => {
    const Key = "lifewood-local/files/a.mp4";
    const { bucket, sent } = bucketWith(() => ({ IsTruncated: true, NextKeyMarker: "lifewood-local/files/a.mp4.bak", NextVersionIdMarker: "x",
      Versions: [{ Key, VersionId: "v2" }, { Key, VersionId: "v1" }, { Key: `${Key}.bak`, VersionId: "other" }], DeleteMarkers: [{ Key, VersionId: "m1" }] }));
    assert.deepEqual(await bucket.listVersions("files/a.mp4"), [{ versionId: "v2", deleteMarker: false }, { versionId: "v1", deleteMarker: false }, { versionId: "m1", deleteMarker: true }]);
    assert.deepEqual(sent.map(command => command.name), ["ListObjectVersionsCommand"]);
    assert.equal(sent[0].input.Prefix, Key);
  });
  test("follows pagination of the same key and refuses a stuck or unbounded listing", async () => {
    const Key = "lifewood-local/files/a.mp4";
    let page = 0;
    const paged = bucketWith(() => ++page === 1 ? { IsTruncated: true, NextKeyMarker: Key, NextVersionIdMarker: "v2", Versions: [{ Key, VersionId: "v2" }] } : { IsTruncated: false, Versions: [{ Key, VersionId: "v1" }] });
    assert.deepEqual((await paged.bucket.listVersions("files/a.mp4")).map(version => version.versionId), ["v2", "v1"]);
    assert.equal(paged.sent[1].input.VersionIdMarker, "v2");
    const stuck = bucketWith(command => ({ IsTruncated: true, NextKeyMarker: command.input.KeyMarker ?? Key, NextVersionIdMarker: command.input.VersionIdMarker ?? "v1", Versions: [] }));
    await assert.rejects(stuck.bucket.listVersions("files/a.mp4"), /Version lookup is ambiguous/);
    const unidentified = bucketWith(() => ({ Versions: [{ Key, VersionId: "null" }] }));
    await assert.rejects(unidentified.bucket.listVersions("files/a.mp4"), /Unidentified storage version/);
  });
});
