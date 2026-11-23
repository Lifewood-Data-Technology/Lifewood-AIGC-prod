import { createHash } from "node:crypto";
import { createRelayTransport } from "./deseret-relay-transport";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  HeadObjectCommand, S3Client, UploadPartCopyCommand,
  type AbortMultipartUploadCommandInput, type CompleteMultipartUploadCommandInput,
  type CompleteMultipartUploadCommandOutput, type CreateMultipartUploadCommandInput,
  type CreateMultipartUploadCommandOutput, type HeadObjectCommandInput, type HeadObjectCommandOutput,
  type UploadPartCopyCommandInput, type UploadPartCopyCommandOutput,
} from "@aws-sdk/client-s3";
import { validateHandoffManifest, type HandoffMaterial } from "../lib/deseret-integration-contract.ts";
import { wasabiAgentOptions } from "./wasabi-proxy.ts";

type Integrity = NonNullable<HandoffMaterial["integrity"]>;
type Profile = { id: string; bucket: string; endpoint: string; region: string; prefix: string };
export type MaterialTransferConfig = {
  strategy: "pending" | "server_copy" | "deseret_relay";
  deseret: Profile;
  aigc: Profile;
  accessKeyId: string;
  secretAccessKey: string;
  httpProxy?: string;
  deseretReviewPrefix?: string;
};
export type MaterialSourceReceipt = {
  etag: string; size: number; integrity: Integrity;
  checksumSha256?: string; checksumType?: string; versionId?: string;
};
export type MaterialTransferInput = {
  projectId: string; sourceRevision: string; file: HandoffMaterial;
  deseretProjectId?: string;
  direction: "deseret_to_aigc" | "aigc_to_deseret";
  signal?: AbortSignal;
  // The worker supplies this receipt from its verified native storage records.
  // Inbound HTTP payloads must never be treated as native receipts.
  sourceReceipt?: MaterialSourceReceipt;
  targetStorageProfileId?: string;
  reviewObjectPrefix?: string;
  multipartUploadId?: string;
  sourcePin?: {etag: string; versionId?: string};
  onMultipartCreated?: (uploadId: string, sourcePin?: {etag: string; versionId?: string}) => Promise<void>;
};
export type MaterialTransferLocation = {
  storageProfileId: string; bucket: string; endpoint: string; region: string;
  prefix: string; objectKey: string;
};
export type MaterialTransferPlan = {
  id: string;
  receiptId: string;
  transport?: "deseret_relay";
  file: HandoffMaterial;
  source: MaterialTransferLocation;
  target: MaterialTransferLocation;
};
export interface MaterialTransferTransport {
  dispose?(): void;
  head(input: HeadObjectCommandInput, signal: AbortSignal): Promise<HeadObjectCommandOutput>;
  begin(input: CreateMultipartUploadCommandInput, signal: AbortSignal): Promise<CreateMultipartUploadCommandOutput>;
  copyPart(input: UploadPartCopyCommandInput, signal: AbortSignal): Promise<UploadPartCopyCommandOutput>;
  complete(input: CompleteMultipartUploadCommandInput, signal: AbortSignal): Promise<CompleteMultipartUploadCommandOutput>;
  listParts?(input: {Bucket: string; Key: string; UploadId: string}, signal: AbortSignal): Promise<{PartNumber: number; ETag: string; Size: number}[]>;
  abort(input: AbortMultipartUploadCommandInput, signal: AbortSignal): Promise<unknown>;
}
export class TransferUnavailableError extends Error {
  readonly recoverable = true;
  constructor(readonly code: "TRANSFER_NOT_CONFIGURED" | "TRANSFER_REGION_UNSUPPORTED" | "TRANSFER_INTEGRITY_UNAVAILABLE" | "TRANSFER_SOURCE_CHANGED" | "TRANSFER_DESTINATION_CONFLICT" | "TRANSFER_PLAN_MISMATCH", message: string) {
    super(message);
    this.name = "TransferUnavailableError";
  }
}

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Storage endpoint is required."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Storage endpoint must be an HTTPS origin.");
  return url.origin;
}
function validPrefix(value: string) {
  return value === "" || (!value.startsWith("/") && value.endsWith("/") && !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "." || segment === "..") &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 31));
}
function validateProfile(profile: Profile) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(profile.id) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(profile.bucket) ||
    !/^[a-z0-9-]{1,64}$/.test(profile.region) || !validPrefix(profile.prefix)) {
    throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Storage profile is incomplete.");
  }
  return { ...profile, endpoint: origin(profile.endpoint) };
}
export function deseretStorageProfileId(profile: Pick<Profile, "endpoint" | "bucket" | "region">): string {
  return createHash("sha256").update(`${origin(profile.endpoint)}/${profile.bucket}/configuration-check|${profile.region}`).digest("hex").toUpperCase();
}

export function readMaterialTransferConfig(env: NodeJS.ProcessEnv = process.env): MaterialTransferConfig {
  const prefix = "LIFEWOOD_DESERET_TRANSFER_";
  const strategy = env[prefix + "STRATEGY"] || "pending";
  if (strategy !== "pending" && strategy !== "server_copy" && strategy !== "deseret_relay") throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Unknown material transfer strategy.");
  return {
    strategy,
    deseret: {
      id: env[prefix + "DESERET_PROFILE_ID"] || "", bucket: env[prefix + "DESERET_BUCKET"] || "",
      endpoint: env[prefix + "DESERET_ENDPOINT"] || "", region: env[prefix + "DESERET_REGION"] || "",
      prefix: env[prefix + "DESERET_PREFIX"] || "",
    },
    aigc: {
      id: env[prefix + "AIGC_PROFILE_ID"] || "", bucket: env.WASABI_BUCKET || "",
      endpoint: env.WASABI_ENDPOINT || "", region: env.WASABI_REGION || "", prefix: env.WASABI_PREFIX || "",
    },
    accessKeyId: env.WASABI_ACCESS_KEY_ID || "", secretAccessKey: env.WASABI_SECRET_ACCESS_KEY || "",
    ...(env.WASABI_HTTP_PROXY ? { httpProxy: env.WASABI_HTTP_PROXY } : {}),
    deseretReviewPrefix: env[prefix + "DESERET_REVIEW_PREFIX"] || "aigc-review/",
  };
}

function sdkTransport(config: MaterialTransferConfig): MaterialTransferTransport {
  const client = new S3Client({
    endpoint: config.aigc.endpoint, region: config.aigc.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
    requestHandler: { ...wasabiAgentOptions(config.httpProxy), connectionTimeout: 10000, socketTimeout: 120000, throwOnRequestTimeout: true },
  });
  return {
    dispose: () => client.destroy(),
    head: (input, signal) => client.send(new HeadObjectCommand(input), { abortSignal: signal }),
    begin: (input, signal) => client.send(new CreateMultipartUploadCommand(input), { abortSignal: signal }),
    copyPart: (input, signal) => client.send(new UploadPartCopyCommand(input), { abortSignal: signal }),
    complete: (input, signal) => client.send(new CompleteMultipartUploadCommand(input), { abortSignal: signal }),
    abort: (input, signal) => client.send(new AbortMultipartUploadCommand(input), { abortSignal: signal }),
  };
}
function etag(value: string | undefined): string {
  return (value || "").replaceAll('"', "");
}
function integrityOf(file: HandoffMaterial): Integrity {
  return file.integrity ?? { algorithm: "sha256", value: file.sha256! };
}
function metadataIntegrity(head: HeadObjectCommandOutput, expected: Integrity) {
  const algorithm = head.Metadata?.["lifewood-integrity-algorithm"];
  const value = head.Metadata?.["lifewood-integrity-value"];
  if (algorithm || value) return algorithm === expected.algorithm && value === expected.value;
  return expected.algorithm === "sha256" && head.Metadata?.["lifewood-sha256"] === expected.value;
}
function verifySource(file: HandoffMaterial, head: HeadObjectCommandOutput, receipt?: MaterialSourceReceipt) {
  const expected = integrityOf(file);
  if (head.ContentLength !== file.size || !etag(head.ETag)) throw new TransferUnavailableError("TRANSFER_SOURCE_CHANGED", "Source storage identity changed.");
  const recorded = receipt && receipt.size === file.size && etag(receipt.etag) === etag(head.ETag) &&
    receipt.integrity.algorithm === expected.algorithm && receipt.integrity.value === expected.value &&
    (!receipt.versionId || receipt.versionId === head.VersionId) &&
    (!receipt.checksumSha256 || receipt.checksumSha256 === head.ChecksumSHA256) &&
    (!receipt.checksumType || receipt.checksumType === head.ChecksumType);
  if (expected.algorithm === "wasabi-sha256-parts-v1") {
    if (!recorded) throw new TransferUnavailableError("TRANSFER_INTEGRITY_UNAVAILABLE", "Composite integrity requires a pinned native verification receipt.");
  } else {
    const expectedBase64 = Buffer.from(expected.value, "hex").toString("base64");
    const checksum = head.ChecksumSHA256 && head.ChecksumType !== "COMPOSITE";
    if (checksum && head.ChecksumSHA256 !== expectedBase64) throw new TransferUnavailableError("TRANSFER_SOURCE_CHANGED", "Source SHA-256 mismatch.");
    if (!checksum && !metadataIntegrity(head, expected) && !recorded) throw new TransferUnavailableError("TRANSFER_INTEGRITY_UNAVAILABLE", "Source checksum confirmation is unavailable.");
  }
}
function transferIdentity(input: MaterialTransferInput): string {
  return createHash("sha256").update(JSON.stringify({ projectId: input.projectId, deseretProjectId: input.deseretProjectId, sourceRevision: input.sourceRevision, file: input.file, direction: input.direction })).digest("hex");
}

function matchesTransferReceipt(input: MaterialTransferInput, receipt: string | undefined, expected: string): boolean {
  if (receipt === expected) return true;
  // Native publication can reuse the same immutable video in either phase.
  // Preserve existing receipts and persisted plans. Only the supported phase
  // purpose may differ when recognizing an already-owned destination.
  if (input.direction !== "aigc_to_deseret") return false;
  const purpose = input.file.purpose === "storyboard_video" ? "final_video"
    : input.file.purpose === "final_video" ? "storyboard_video" : undefined;
  return purpose !== undefined && receipt === transferIdentity({ ...input, file: { ...input.file, purpose } });
}

const copyPartBytes = 1024 ** 3;
export function materialTransferBudget(size: number, strategy = "server_copy") {
  if (!Number.isSafeInteger(size) || size < 1) throw Error("Invalid material copy size.");
  const parts = Math.ceil(size / (strategy === "deseret_relay" ? 8 * 1024 ** 2 : copyPartBytes));
  if (parts > 10000) throw Error("Material exceeds the supported multipart count.");
  const timeoutMs = Math.max(10 * 60000, parts * 120000 + 120000);
  return { timeoutMs, leaseMs: strategy === "deseret_relay" ? 3 * 60000 : timeoutMs + 2 * 60000 };
}

export function planDeseretMaterialTransfer(config: MaterialTransferConfig, input: MaterialTransferInput): MaterialTransferPlan {
  if (config.strategy !== "server_copy" && config.strategy !== "deseret_relay") throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Material transfer awaits configuration.");
  const computedDeseretId = deseretStorageProfileId(config.deseret);
  if (config.deseret.id && config.deseret.id !== computedDeseretId) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Deseret storage profile does not match the configured bucket identity.");
  const deseret = validateProfile({ ...config.deseret, id: computedDeseretId }), aigc = validateProfile(config.aigc);
  if (deseret.id === aigc.id || !config.accessKeyId || !config.secretAccessKey) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Independent storage profiles and AIGC credentials are required.");
  if (config.strategy === "server_copy" && (deseret.endpoint !== aigc.endpoint || deseret.region !== aigc.region)) throw new TransferUnavailableError("TRANSFER_REGION_UNSUPPORTED", "Server-side copy requires matching storage endpoints and regions.");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(input.projectId) || !input.sourceRevision || input.sourceRevision.length > 120 || !["deseret_to_aigc", "aigc_to_deseret"].includes(input.direction)) throw Error("Invalid transfer project identity.");
  const [file] = validateHandoffManifest([input.file]);
  materialTransferBudget(file.size, config.strategy);
  const source = input.direction === "deseret_to_aigc" ? deseret : aigc;
  const target = input.direction === "deseret_to_aigc" ? aigc : deseret;
  if (input.targetStorageProfileId && input.targetStorageProfileId !== target.id) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Target storage profile does not match the project handoff.");
  if (file.storageProfileId !== source.id) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Source storage profile does not match the configured platform.");
  const digest = integrityOf(file), receiptId = transferIdentity({ ...input, file });
  const revisionKey = createHash("sha256").update(input.sourceRevision).digest("hex").slice(0, 32);
  const reviewPrefix = config.deseretReviewPrefix || "aigc-review/";
  if (!validPrefix(reviewPrefix)) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Invalid publisher review object prefix.");
  if (input.direction === "aigc_to_deseret" && (!input.deseretProjectId || !/^[A-Za-z0-9_-]{1,120}$/.test(input.deseretProjectId) || !input.reviewObjectPrefix || !input.targetStorageProfileId)) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Publisher project and destination references are required.");
  const targetPrefix = input.direction === "aigc_to_deseret" ? `${reviewPrefix}${input.deseretProjectId}/` : `platform-handoffs/${input.projectId}/`;
  if (input.reviewObjectPrefix && input.reviewObjectPrefix !== targetPrefix) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Publisher review prefix does not match this project.");
  const objectKey = `${targetPrefix}${revisionKey}/${file.id}/v${file.version}/${digest.algorithm}/${digest.value}`;
  const location = (profile: Profile, key: string, isDeseret: boolean): MaterialTransferLocation => {
    // Deseret's wire keys are complete bucket keys. Its configured prefix is a
    // namespace restriction. AIGC's existing internal API uses relative keys.
    if (isDeseret && !key.startsWith(profile.prefix)) throw new TransferUnavailableError("TRANSFER_NOT_CONFIGURED", "Deseret object is outside the configured namespace.");
    return Object.freeze({
    storageProfileId: profile.id, bucket: profile.bucket, endpoint: profile.endpoint,
    region: profile.region, prefix: profile.prefix, objectKey: isDeseret ? key : profile.prefix + key,
    });
  };
  const result = { ...file, storageProfileId: target.id, objectKey };
  if (result.integrity) Object.freeze(result.integrity);
  Object.freeze(result);
  const details = { ...(config.strategy === "deseret_relay" ? {transport: "deseret_relay" as const} : {}), receiptId, file: result, source: location(source, file.objectKey, input.direction === "deseret_to_aigc"), target: location(target, objectKey, input.direction === "aigc_to_deseret") };
  return Object.freeze({ id: createHash("sha256").update(JSON.stringify(details)).digest("hex"), ...details });
}

export function createDeseretMaterialTransfer(config = readMaterialTransferConfig(), suppliedTransport?: MaterialTransferTransport) {
  config = { ...config, deseret: { ...config.deseret }, aigc: { ...config.aigc } };

  const service = {
    planTransfer: (input: MaterialTransferInput) => planDeseretMaterialTransfer(config, input),
    async abortTransfer(input: MaterialTransferInput, recordedPlan: MaterialTransferPlan) {
      const plan=planDeseretMaterialTransfer(config,input);
      if(JSON.stringify(plan)!==JSON.stringify(recordedPlan)||!input.multipartUploadId||input.multipartUploadId.length>4096)throw new TransferUnavailableError('TRANSFER_PLAN_MISMATCH','Upload cleanup requires its owned persisted plan.');
      const transport=suppliedTransport??(config.strategy==='deseret_relay'?createRelayTransport(config,input,plan):sdkTransport(config));
      try{await transport.abort({Bucket:plan.target.bucket,Key:plan.target.objectKey,UploadId:input.multipartUploadId},input.signal??AbortSignal.timeout(30000));}
      catch(error){if((error as {name?:string}).name!=='NoSuchUpload')throw error;}
      finally{if(!suppliedTransport)transport.dispose?.();}
    },
    async transferFile(input: MaterialTransferInput, recordedPlan?: MaterialTransferPlan): Promise<HandoffMaterial> {
      const plan = planDeseretMaterialTransfer(config, input);
      if (recordedPlan && JSON.stringify(recordedPlan) !== JSON.stringify(plan)) throw new TransferUnavailableError("TRANSFER_PLAN_MISMATCH", "The persisted storage plan requires reconciliation before retry.");
      const [file] = validateHandoffManifest([input.file]);
      const { source, target, receiptId } = plan;
      const digest = integrityOf(file), sourceKey = source.objectKey, targetKey = target.objectKey;
      const transport = suppliedTransport ?? (config.strategy === "deseret_relay" ? createRelayTransport(config, input, plan) : sdkTransport(config));
      const within = (milliseconds: number) => input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
      const targetHead = async () => {
        try { return await transport!.head({ Bucket: target.bucket, Key: targetKey, ChecksumMode: "ENABLED" }, within(config.strategy === "deseret_relay" ? 60000 : 15000)); }
        catch (error) {
          const failure = error as { code?: string; $metadata?: { httpStatusCode?: number } };
          if (failure.$metadata?.httpStatusCode === 404 && failure.code !== "TRANSFER_NOT_CONFIGURED") return null;
          throw error;
        }
      };
      const result = plan.file;
      const confirm = (head: HeadObjectCommandOutput) => {
        if (head.ContentLength !== file.size || !etag(head.ETag) || !metadataIntegrity(head, digest) || !matchesTransferReceipt({ ...input, file }, head.Metadata?.["lifewood-transfer"], receiptId)) throw new TransferUnavailableError("TRANSFER_DESTINATION_CONFLICT", "Existing target metadata does not match the transfer receipt.");
        if (digest.algorithm === "sha256" && head.ChecksumSHA256 && head.ChecksumType !== "COMPOSITE" && head.ChecksumSHA256 !== Buffer.from(digest.value, "hex").toString("base64")) throw new TransferUnavailableError("TRANSFER_DESTINATION_CONFLICT", "Target SHA-256 mismatch.");
        return result;
      };
      try {
      const existing = await targetHead();
      if (existing) return confirm(existing);
      const sourceHead = await transport.head({ Bucket: source.bucket, Key: sourceKey, ChecksumMode: "ENABLED", VersionId: input.sourcePin?.versionId }, within(config.strategy === "deseret_relay" ? 60000 : 15000));
      verifySource(file, sourceHead, input.sourceReceipt);
      const sourcePin={etag:etag(sourceHead.ETag),...(sourceHead.VersionId?{versionId:sourceHead.VersionId}:{})};
      if (config.strategy === "deseret_relay" && (input.multipartUploadId || input.sourcePin)) {
        if (!input.sourcePin || input.sourcePin.etag !== sourcePin.etag || input.sourcePin.versionId !== sourcePin.versionId) {
          throw new TransferUnavailableError("TRANSFER_SOURCE_CHANGED", "Persisted source identity changed; reconcile the upload before retry.");
        }
      }
      const copySource = `${source.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}${sourceHead.VersionId ? `?versionId=${encodeURIComponent(sourceHead.VersionId)}` : ""}`;
      let uploadId = input.multipartUploadId;
      if (uploadId && (uploadId.length > 4096 || Array.from(uploadId).some((character) => character.charCodeAt(0) <= 32))) throw Error("Invalid persisted multipart identity.");
      if (!uploadId) {
        const created = await transport.begin({
          Bucket: target.bucket, Key: targetKey, ContentType: file.mimeType,
          Metadata: { "lifewood-integrity-algorithm": digest.algorithm, "lifewood-integrity-value": digest.value, "lifewood-transfer": receiptId },
        }, within(config.strategy === "deseret_relay" ? 60000 : 15000));
        if (!created.UploadId) throw Error("Storage copy did not return an upload identity.");
        uploadId = created.UploadId;
        try { await input.onMultipartCreated?.(uploadId, sourcePin); }
        catch (error) {
          await transport.abort({ Bucket: target.bucket, Key: targetKey, UploadId: uploadId }, AbortSignal.timeout(15000)).catch(() => {});
          throw error;
        }
      }
      try {
        const partSize = config.strategy === "deseret_relay" ? 8 * 1024 ** 2 : copyPartBytes;
        const partCount = Math.ceil(file.size / partSize);
        if (partCount > 10000) throw Error("Material exceeds the supported server-copy size.");
        const parts = [];
        const previous = input.multipartUploadId && transport.listParts ? await transport.listParts({Bucket: target.bucket, Key: targetKey, UploadId: uploadId}, within(30000)) : [];
        for (let part = 1; part <= partCount; part++) {
          const start = (part - 1) * partSize, end = Math.min(file.size, start + partSize) - 1;
          const retained = previous.find(value => value.PartNumber === part && value.Size === end - start + 1 && value.ETag);
          if (retained) { parts.push({PartNumber: part, ETag: retained.ETag}); continue; }
          const copied = await transport.copyPart({
            Bucket: target.bucket, Key: targetKey, UploadId: uploadId, PartNumber: part,
            CopySource: copySource, CopySourceIfMatch: `"${etag(sourceHead.ETag)}"`, CopySourceRange: `bytes=${start}-${end}`,
          }, within(120000));
          if (!copied.CopyPartResult?.ETag) throw Error("Storage copy part was not confirmed.");
          parts.push({ PartNumber: part, ETag: copied.CopyPartResult.ETag });
        }
        await transport.complete({ Bucket: target.bucket, Key: targetKey, UploadId: uploadId, IfNoneMatch: "*", MultipartUpload: { Parts: parts } }, within(30000));
        const head = await targetHead();
        if (!head) throw Error("Copied material is not visible in target storage.");
        return confirm(head);
      } catch (error) {
        if (!input.onMultipartCreated) await transport.abort({ Bucket: target.bucket, Key: targetKey, UploadId: uploadId }, AbortSignal.timeout(15000)).catch(() => {});
        // An interrupted completion can leave either a confirmed object or an
        // expired/aborted handle. Re-enter through HEAD and replace only a handle
        // the provider explicitly confirms is missing.
        if ((error as { name?: string }).name === "NoSuchUpload" && input.multipartUploadId && !input.signal?.aborted) {
          return service.transferFile({ ...input, multipartUploadId: undefined }, plan);
        }
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) {
          const concurrent = await targetHead();
          if (concurrent) return confirm(concurrent);
        }
        throw error;
      }
      } finally { if (!suppliedTransport) transport.dispose?.(); }
    },
  };
  return service;
}
