import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRelayRpc } from "../runtime/deseret-relay-transport.ts";
import { authenticate, RESPONSE_SIGNATURE_HEADER, signRpc, signRpcResponse } from "../services/deseret-transfer-worker/protocol.mjs";
import { createSourceAuthorizer } from "../services/deseret-transfer-worker/source-authorization.mjs";
import { createExecutor } from "../services/deseret-transfer-worker/worker.mjs";

const control = { keyId: "control-test", secret: "control-test-".repeat(4) };
const publisher = {
  authOrigin: "https://publisher.invalid",
  authKeyId: "authorizer-test",
  authSecret: "authorizer-test-".repeat(4),
};
const payload = Buffer.from("a synthetic approved cover");
const digest = createHash("sha256").update(payload).digest("hex");
const source = {
  projectId: "book-test",
  sourceRevision: "brief-v3",
  file: {
    id: "cover-test", version: 1, size: payload.length, sha256: digest,
    objectKey: "sources/cover", storageProfileId: "publisher-storage",
  },
};

test("relay control accepts only the matching signed body, identity and time window", () => {
  const body = JSON.stringify({ op: "head", key: source.file.objectKey });
  const requestId = "request-123";
  const timestamp = "1800000000";
  const now = Number(timestamp) * 1000;
  const headers = {
    "x-lw-request-id": requestId, "x-lw-timestamp": timestamp, "x-lw-key-id": control.keyId,
    "x-lw-signature": signRpc(body, control, requestId, timestamp),
  };
  assert.equal(authenticate(headers, body, control, now), requestId);
  assert.throws(() => authenticate(headers, body + " ", control, now), { code: "UNAUTHORIZED" });
  assert.throws(() => authenticate(headers, body, control, now + 301_000), { code: "UNAUTHORIZED" });
  assert.throws(() => authenticate(headers, body, { ...control, keyId: publisher.authKeyId }, now), { code: "UNAUTHORIZED" });
  assert.throws(() => authenticate(headers, body, { ...control, secret: publisher.authSecret }, now), { code: "UNAUTHORIZED" });
});

test("an unsigned HTTP 200 cannot acknowledge a successful transfer operation", async () => {
  const settings = { ...control, origin: "https://worker.invalid", allowLoopbackHttp: false };
  const rpc = createRelayRpc(settings, async (_url, options) => {
    const requestId = new Headers(options?.headers).get("x-lw-request-id");
    assert.ok(requestId);
    return Response.json({ requestId, result: { ETag: "test-etag" } });
  });
  await assert.rejects(rpc({ op: "head" }, new AbortController().signal), { code: "TRANSFER_NOT_CONFIGURED" });
});

test("an unsigned proxy precondition response cannot invalidate an approved source", async () => {
  const settings = { ...control, origin: "https://worker.invalid", allowLoopbackHttp: false };
  for (const body of ["upstream precondition failed", JSON.stringify({ code: "SOURCE_SIZE_CHANGED" })]) {
    const rpc = createRelayRpc(settings, async () => new Response(body, { status: 412 }));
    await assert.rejects(rpc({ op: "part" }, new AbortController().signal), { code: "TRANSFER_NOT_CONFIGURED" });
  }
});

test("a correctly signed HTTP 200 acknowledging a different request must be retried", async () => {
  const settings = { ...control, origin: "https://worker.invalid", allowLoopbackHttp: false };
  const rpc = createRelayRpc(settings, async (_url, options) => {
    const requestId = new Headers(options?.headers).get("x-lw-request-id");
    assert.ok(requestId && requestId !== "other-request");
    const body = JSON.stringify({ requestId: "other-request", result: { ETag: "test-etag" } });
    return new Response(body, { headers: {
      [RESPONSE_SIGNATURE_HEADER]: signRpcResponse(body, settings, requestId, 200),
    } });
  });
  await assert.rejects(rpc({ op: "head" }, new AbortController().signal), { code: "TRANSFER_RETRY" });
});

test("the worker asks Deseret to authorize the exact frozen source with its dedicated identity", async () => {
  const path = "/api/integrations/aigc/relay-authorize";
  const authorize = createSourceAuthorizer(publisher, async (url, options) => {
    assert.equal(url, publisher.authOrigin + path);
    assert.equal(options?.method, "POST");
    assert.equal(options.redirect, "error");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("x-lw-service"), "relay");
    assert.equal(headers.get("x-lw-key-id"), publisher.authKeyId);
    const body = String(options.body);
    const requestId = headers.get("x-lw-request-id");
    assert.ok(requestId);
    assert.deepEqual(JSON.parse(body), { ...source, requestId });
    const canonical = ["LW-INTEGRATION-V1", "relay", publisher.authKeyId,
      headers.get("x-lw-timestamp"), requestId, "POST", path,
      createHash("sha256").update(body).digest("hex")].join("\n");
    assert.equal(headers.get("x-lw-signature"), createHmac("sha256", publisher.authSecret).update(canonical).digest("hex"));
    return Response.json({ requestId, authorized: true });
  });
  await authorize(source, new AbortController().signal);
});

test("authorization fails closed on missing sources, stale acknowledgements and service failure", async () => {
  const cases: Array<[() => Response, string]> = [
    [() => new Response(null, { status: 404 }), "SOURCE_NOT_AUTHORIZED"],
    [() => Response.json({ requestId: "other", authorized: true }), "SOURCE_NOT_AUTHORIZED"],
    [() => new Response(null, { status: 503 }), "AUTHORIZATION_UNAVAILABLE"],
    [() => new Response("x".repeat(4097)), "AUTHORIZATION_UNAVAILABLE"],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(createSourceAuthorizer(publisher, async () => response())(source, new AbortController().signal), { code });
  }
});

test("the worker checks publisher authorization before accessing the source bucket", async () => {
  const config = { bucket: "publisher-test", storageProfileId: source.file.storageProfileId,
    sourcePrefixes: ["sources/"], reviewPrefix: "reviews/" };
  const signal = new AbortController().signal;
  let storageReads = 0;
  const execute = createExecutor(config, { async send() { storageReads++; } }, fetch,
    createSourceAuthorizer(publisher, async () => new Response(null, { status: 404 })));
  await assert.rejects(execute({ op: "head", direction: "deseret_to_aigc", key: source.file.objectKey, source }, signal), {
    code: "SOURCE_NOT_AUTHORIZED",
  });
  assert.equal(storageReads, 0);
});

test("relay distinguishes an unverified source from a changed source for either SHA-256 manifest format", async () => {
  const config = { bucket: "publisher-test", storageProfileId: source.file.storageProfileId,
    sourcePrefixes: ["sources/"], reviewPrefix: "reviews/" };
  let declared: string | undefined = digest;
  const signal = new AbortController().signal;
  const execute = createExecutor(config, { async send() {
    return { ContentLength: payload.length, ETag: '"pinned"', Metadata: { "lifewood-sha256": declared } };
  } }, fetch, async () => {});
  const { sha256, ...fields } = source.file;
  const job = { op: "head", direction: "deseret_to_aigc", key: fields.objectKey,
    source: { ...source, file: { ...fields, integrity: { algorithm: "sha256", value: sha256 } } } };
  assert.equal((await execute(job, signal)).ETag, '"pinned"');
  declared = undefined;
  await assert.rejects(execute(job, signal), { code: "TRANSFER_INTEGRITY_UNAVAILABLE" });
  declared = "0".repeat(64);
  await assert.rejects(execute(job, signal), { code: "SOURCE_SIZE_CHANGED" });
});

test("independent accounts can relay each direction with only a scoped peer URL", async () => {
  const config = {
    bucket: "publisher-account-us", reviewPrefix: "reviews/", sourcePrefixes: ["sources/"],
    storageProfileId: source.file.storageProfileId, aigcBucket: "studio-account-sg",
    aigcEndpoint: "https://s3.ap-southeast-1.wasabisys.com",
    aigcWritePrefixes: ["intake/"], aigcReadPrefixes: ["renders/"],
  };
  const studioSigner = new S3Client({
    endpoint: config.aigcEndpoint, region: "ap-southeast-1", forcePathStyle: true,
    credentials: { accessKeyId: "synthetic-studio-account", secretAccessKey: "synthetic-studio-secret" },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const signal = new AbortController().signal;
  const etag = '"pinned-source"';
  const range = `bytes=0-${payload.length - 1}`;
  const contentRange = `bytes 0-${payload.length - 1}/${payload.length}`;
  const partEtag = `"${createHash("md5").update(payload).digest("hex")}"`;
  const transfer = { op: "part", start: 0, end: payload.length - 1, totalSize: payload.length,
    etag, uploadId: "test-upload", partNumber: 1 };
  const destination = { Bucket: config.aigcBucket, Key: "intake/cover", UploadId: transfer.uploadId, PartNumber: 1 };
  const rendered = { Bucket: config.aigcBucket, Key: "renders/final", Range: range, IfMatch: etag };
  try {
    const upload = await getSignedUrl(studioSigner, new UploadPartCommand(destination), { expiresIn: 180 });
    const download = await getSignedUrl(studioSigner, new GetObjectCommand(rendered), {
      expiresIn: 180, signableHeaders: new Set(["range", "if-match"]),
    });
    let approvals = 0;
    let peerWrites = 0;
    let publisherWrites = 0;
    const publisherStorage = {
      async send(command: { constructor: { name: string }; input: { Bucket: string; Body?: Buffer } }) {
        assert.equal(command.input.Bucket, config.bucket);
        switch (command.constructor.name) {
          case "HeadObjectCommand":
            return { ContentLength: payload.length, ETag: etag, Metadata: { "lifewood-sha256": digest } };
          case "GetObjectCommand":
            return { ContentLength: payload.length, ContentRange: contentRange, ETag: etag, Body: Readable.from([payload]) };
          case "UploadPartCommand":
            assert.deepEqual(command.input.Body, payload);
            publisherWrites++;
            return { ETag: partEtag };
          default:
            assert.fail("unexpected publisher storage call");
        }
      },
    };
    const execute = createExecutor(config, publisherStorage, async (url, options) => {
      assert.equal(options?.redirect, "error");
      if (url === upload) {
        assert.equal(options.method, "PUT");
        assert.deepEqual(options.body, payload);
        peerWrites++;
        return new Response(null, { headers: { etag: partEtag } });
      }
      assert.equal(url, download);
      assert.equal(new Headers(options.headers).get("if-match"), etag);
      return new Response(new Uint8Array(payload), { status: 206, headers: {
        etag, "content-length": String(payload.length), "content-range": contentRange,
      } });
    }, async (approvedSource) => {
      assert.deepEqual(approvedSource, source);
      approvals++;
    });
    await execute({ ...transfer, direction: "deseret_to_aigc", source, key: source.file.objectKey,
      peerKey: destination.Key, url: upload }, signal);
    await execute({ ...transfer, direction: "aigc_to_deseret", key: "reviews/final",
      peerKey: rendered.Key, url: download }, signal);
    assert.equal(approvals, 2); // Before reading, then again before forwarding.
    assert.equal(peerWrites, 1);
    assert.equal(publisherWrites, 1);
  } finally {
    studioSigner.destroy();
  }
});
