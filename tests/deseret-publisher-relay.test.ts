import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { HeadObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { deseretStorageProfileId, planDeseretMaterialTransfer, type MaterialTransferConfig, type MaterialTransferInput } from "../runtime/deseret-material-transfer.ts";
import { createRelayTransport } from "../runtime/deseret-relay-transport.ts";
import { createExecutor } from "../services/deseret-transfer-worker/worker.mjs";

test("a resumed review part reads the project snapshot through the production signer and Deseret worker", async t => {
  const source = Buffer.from("approved storyboard v1");
  const digest = createHash("sha256").update(source).digest("hex");
  const requestedBytes = source.subarray(8);
  const partEtag = '"' + createHash("md5").update(requestedBytes).digest("hex") + '"';
  const config: MaterialTransferConfig = {
    strategy: "deseret_relay",
    aigc: {id:"aigc-sg", bucket:"aigc-test", endpoint:"https://s3.ap-southeast-1.wasabisys.com", region:"ap-southeast-1", prefix:"studio/"},
    deseret: {id:"", bucket:"publisher-test", endpoint:"https://s3.us-east-2.wasabisys.com", region:"us-east-2", prefix:""},
    accessKeyId:"test-studio-key", secretAccessKey:"synthetic-signing-secret",
  };
  const input = {
    projectId:"project-a", publisherClientId:"client-a", deseretProjectId:"book-a", sourceRevision:"brief-v1",
    direction:"aigc_to_deseret", reviewObjectPrefix:"aigc-review/book-a/", targetStorageProfileId:deseretStorageProfileId(config.deseret),
    file:{id:"file-a",version:1,size:source.length,sha256:digest,purpose:"review",name:"storyboard.mp4",
      mimeType:"video/mp4",storageProfileId:config.aigc.id,objectKey:"production-staging/staged-a"},
    sourceReceipt:{size:source.length,etag:"original-etag",integrity:{algorithm:"sha256",value:digest}},
    onPublisherSnapshot: async () => {},
  } as const;
  const plan = planDeseretMaterialTransfer(config, input satisfies MaterialTransferInput);
  const prefix = "studio/clients/client-a/projects/project-a/";
  const snapshotVersion = "snapshot/v1+physical";
  const snapshotEtag = '"snapshot-etag"';
  let snapshotKey = "";
  // The snapshot exists from an earlier attempt. Storage I/O is mocked, signing is real.
  t.mock.method(S3Client.prototype, "send", async (command: HeadObjectCommand) => {
    assert.equal(command.constructor.name, "HeadObjectCommand");
    assert.equal(command.input.Bucket, config.aigc.bucket);
    snapshotKey = String(command.input.Key);
    assert.ok(snapshotKey.startsWith(prefix + "publisher-review/"));
    return {ContentLength:source.length, ETag:snapshotEtag, VersionId:snapshotVersion,
      Metadata:{"publisher-source":snapshotKey.split("/").at(-1)}};
  });
  const workerConfig = {
    bucket:config.deseret.bucket, reviewPrefix:input.reviewObjectPrefix, sourcePrefixes:[],
    aigcBucket:config.aigc.bucket, aigcEndpoint:config.aigc.endpoint, aigcReadPrefixes:[prefix], aigcWritePrefixes:[],
  };
  let delivered = 0;
  const worker = createExecutor(workerConfig, {
    async send(command: UploadPartCommand) {
      assert.equal(command.constructor.name, "UploadPartCommand");
      assert.equal(command.input.Bucket, config.deseret.bucket);
      assert.equal(command.input.Key, plan.target.objectKey);
      assert.equal(command.input.UploadId, "previous-upload");
      assert.equal(command.input.PartNumber, 2);
      assert.deepEqual(command.input.Body, requestedBytes);
      delivered++;
      return {ETag:partEtag};
    },
  }, async (url, options) => {
    const signed = new URL(String(url));
    assert.equal(decodeURIComponent(signed.pathname), "/" + config.aigc.bucket + "/" + snapshotKey);
    assert.equal(signed.searchParams.get("versionId"), snapshotVersion);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("range"), "bytes=8-" + (source.length - 1));
    assert.equal(headers.get("if-match"), snapshotEtag);
    return new Response(new Uint8Array(requestedBytes), {status:206, headers:{
      etag:snapshotEtag, "content-length":String(requestedBytes.length),
      "content-range":"bytes 8-" + (source.length - 1) + "/" + source.length,
    }});
  }, async () => assert.fail("unexpected publisher source authorization"));
  const transport = createRelayTransport(config, input, plan, {
    origin:"https://worker.invalid",keyId:"test-control",secret:"synthetic-control-secret",allowLoopbackHttp:false,
  }, worker);
  const signal = new AbortController().signal;
  try {
    await transport.preparePublisherSource!('"original-etag"', "source-version", signal);
    const result = await transport.copyPart({
      Bucket:config.deseret.bucket, Key:plan.target.objectKey, UploadId:"previous-upload", PartNumber:2,
      CopySource:config.aigc.bucket + "/" + plan.source.objectKey + "?versionId=source-version",
      CopySourceRange:"bytes=8-" + (source.length - 1), CopySourceIfMatch:'"original-etag"',
    }, signal);
    assert.equal(result.CopyPartResult?.ETag, partEtag);
    assert.equal(delivered, 1);
  } finally {
    transport.dispose?.();
  }
});
