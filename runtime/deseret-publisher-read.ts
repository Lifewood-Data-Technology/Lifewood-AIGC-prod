import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  HeadObjectCommand, UploadPartCopyCommand, type S3Client,
} from "@aws-sdk/client-s3";
import type { MaterialTransferConfig, MaterialTransferInput, MaterialTransferPlan } from "./deseret-material-transfer";

type ReadObject = { key: string; versionId?: string; etag: string };

function quotedETag(value: string): string {
  const tag = value.replace(/^"|"$/g, "");
  if (!/^[^"\r\n]{1,256}$/.test(tag)) throw Error("Invalid publisher source ETag.");
  return '"' + tag + '"';
}

export async function preparePublisherRead(client: S3Client, config: MaterialTransferConfig,
  input: MaterialTransferInput, plan: MaterialTransferPlan, versionId: string | undefined,
  etag: string, signal: AbortSignal): Promise<ReadObject> {
  const clientId = input.publisherClientId;
  if (!clientId || !/^[a-zA-Z0-9_-]{1,120}$/.test(clientId) || !/^[a-zA-Z0-9_-]{1,120}$/.test(input.projectId))
    throw Object.assign(new Error("Publisher project binding is missing."), {code:"TRANSFER_NOT_CONFIGURED"});
  const projectPrefix = "clients/" + clientId + "/projects/" + input.projectId + "/";
  const pinnedETag = quotedETag(etag);
  if (plan.source.objectKey.startsWith(config.aigc.prefix + projectPrefix))
    return {key: plan.source.objectKey, versionId, etag: pinnedETag};

  // Native project lookup verifies file ID and object key, including deduplicated and readable-path files.
  const receipt = input.sourceReceipt;
  const expected = input.file.integrity ?? {algorithm:"sha256", value:input.file.sha256};
  if (plan.source.objectKey !== config.aigc.prefix + input.file.objectKey ||
      !receipt || receipt.size !== input.file.size || quotedETag(receipt.etag) !== pinnedETag ||
      receipt.integrity.algorithm !== expected.algorithm || receipt.integrity.value !== expected.value ||
      (receipt.versionId && receipt.versionId !== versionId))
    throw Object.assign(new Error("Unverified project review file."), {code:"TRANSFER_INTEGRITY_UNAVAILABLE"});

  const record = input.onPublisherSnapshot;
  if (!record) throw Object.assign(new Error("Publisher snapshot inventory unavailable."), {code:"TRANSFER_NOT_CONFIGURED"});
  const identity = createHash("sha256").update(JSON.stringify([plan.id, versionId, pinnedETag])).digest("hex");
  const entry = {key: projectPrefix + "publisher-review/" + identity, owner: identity};
  const Bucket = config.aigc.bucket, Key = config.aigc.prefix + entry.key;
  const options = {abortSignal: signal};
  const read = async (): Promise<ReadObject | undefined> => {
    try {
      const head = await client.send(new HeadObjectCommand({Bucket, Key}), options);
      if (head.Metadata?.["publisher-source"] !== identity || head.ContentLength !== input.file.size || !head.ETag)
        throw Object.assign(new Error("Publisher snapshot identity mismatch."), {code:"TRANSFER_DESTINATION_CONFLICT"});
      return {key: Key, etag: quotedETag(head.ETag), versionId: head.VersionId};
    } catch (error) {
      if ((error as {$metadata?: {httpStatusCode?: number}}).$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  };

  await record(entry);
  const existing = await read();
  if (existing) return existing;
  const copySource = Bucket + "/" + plan.source.objectKey.split("/").map(encodeURIComponent).join("/") +
    (versionId ? "?versionId=" + encodeURIComponent(versionId) : "");
  const created = await client.send(new CreateMultipartUploadCommand({Bucket, Key,
    ContentType: input.file.mimeType, Metadata: {"publisher-source": identity}}), options);
  const UploadId = created.UploadId;
  if (!UploadId) throw Error("Publisher snapshot upload ID missing.");
  let finished = false;
  try {
    await record({...entry, uploadId: UploadId});
    const Parts: {PartNumber: number; ETag: string}[] = [];
    const partBytes = 128 * 1024 ** 2;
    for (let start = 0; start < input.file.size; start += partBytes) {
      const PartNumber = Parts.length + 1;
      const part = await client.send(new UploadPartCopyCommand({Bucket, Key, UploadId, PartNumber,
        CopySource: copySource, CopySourceIfMatch: pinnedETag,
        ...(input.file.size > partBytes ? {CopySourceRange: "bytes=" + start + "-" + Math.min(input.file.size - 1, start + partBytes - 1)} : {})}), options);
      if (!part.CopyPartResult?.ETag) throw Error("Publisher snapshot part receipt missing.");
      Parts.push({PartNumber, ETag: part.CopyPartResult.ETag});
    }
    try {
      await client.send(new CompleteMultipartUploadCommand({Bucket, Key, UploadId, IfNoneMatch: "*", MultipartUpload: {Parts}}), options);
      finished = true;
    } catch (error) {
      // Conditional completion may race with another writer or lose its response.
      if (!await read()) throw error;
    }
  } finally {
    if (!finished) await client.send(new AbortMultipartUploadCommand({Bucket, Key, UploadId}),
      {abortSignal: AbortSignal.timeout(10000)}).catch(() => {});
  }
  const saved = await read();
  if (!saved) throw Error("Publisher snapshot completion unconfirmed.");
  await record(entry);
  return saved;
}
