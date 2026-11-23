import { AbortMultipartUploadCommand, DeleteObjectCommand, GetBucketVersioningCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import type { PermanentObjectStore } from "../db/business-deletion";
import { PublicError } from "../lib/security-controls";
import { validateEnvironment } from "./environment";
import { wasabiAgentOptions } from "./wasabi-proxy.ts";

/** Explicitly disabled until this exact deployment's storage purge path is verified. */
export function permanentObjectStore(source: NodeJS.ProcessEnv = process.env): PermanentObjectStore {
  let client: S3Client | undefined;
  function connection() {
    validateEnvironment(source);
    const identity = `${source.MYSQL_DATABASE}:${source.WASABI_BUCKET}:${source.WASABI_PREFIX}`;
    if (source.LIFEWOOD_PERMANENT_DELETE_ENABLED !== "true") {
      throw new PublicError("Permanent deletion is disabled in this environment.", 503, "PERMANENT_DELETION_DISABLED");
    }
    if (source.LIFEWOOD_PERMANENT_DELETE_RESOURCE !== identity) {
      throw new PublicError("The deletion resource does not match the configured storage.", 503, "PERMANENT_DELETION_RESOURCE_MISMATCH");
    }
    return client ??= new S3Client({ region: source.WASABI_REGION, endpoint: source.WASABI_ENDPOINT, credentials: { accessKeyId: source.WASABI_ACCESS_KEY_ID!, secretAccessKey: source.WASABI_SECRET_ACCESS_KEY! }, maxAttempts: 1,
      requestHandler: wasabiAgentOptions(source.WASABI_HTTP_PROXY) });
  }
  return {
    async assertReady(locations = []) {
      connection();
      if (locations.some(location => location.provider !== "wasabi" || location.bucket !== source.WASABI_BUCKET || location.endpoint.replace(/\/$/, "") !== source.WASABI_ENDPOINT?.replace(/\/$/, "") || location.region !== undefined && location.region !== source.WASABI_REGION || location.prefix !== undefined && location.prefix !== source.WASABI_PREFIX)) {
        throw new PublicError("The selected files lie outside the configured deletion storage.", 409, "PERMANENT_DELETION_LOCATION_MISMATCH");
      }
    },
    async abortMultipart(relativeKey, uploadId) {
      const s3 = connection();
      if (!relativeKey || relativeKey.startsWith('/') || relativeKey.split('/').some(part => part === '..') || relativeKey.includes('\0') || !uploadId || uploadId.length > 4096) throw Error("Invalid multipart cleanup identity");
      try {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: source.WASABI_BUCKET!, Key: source.WASABI_PREFIX! + relativeKey, UploadId: uploadId }), { abortSignal: AbortSignal.timeout(30000) });
      } catch (error) {
        if ((error as { name?: string }).name !== "NoSuchUpload") throw error;
      }
    },
    async assertOwned(relativeKey, claims) {
      const s3 = connection();
      if (!relativeKey || relativeKey.startsWith('/') || relativeKey.split('/').some(part => part === '..') || relativeKey.includes('\0') || !claims.length) throw Error("Invalid integration ownership identity");
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: source.WASABI_BUCKET!, Key: source.WASABI_PREFIX! + relativeKey }), { abortSignal: AbortSignal.timeout(15000) });
        if (!claims.some(claim => head.Metadata?.[claim.metadataKey] === claim.owner)) throw new PublicError("Integration object ownership requires reconciliation.", 409, "DESERET_DELETION_INVENTORY_UNAVAILABLE");
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      }
    },
    async purge(relativeKey: string) {
      const s3 = connection(), Bucket = source.WASABI_BUCKET!;
      if (!relativeKey || relativeKey.startsWith("/") || relativeKey.split("/").some(value => value === "..") || relativeKey.includes("\0")) throw new Error("Invalid object key");
      const Key = source.WASABI_PREFIX! + relativeKey;
      const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket }));
      if (versioning.Status === "Enabled" || versioning.Status === "Suspended") {
        let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
        const versions: string[] = [];
        do {
          const page = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
          for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) if (item.Key === Key) {
            if (!item.VersionId) throw new Error("Unidentified storage version");
            versions.push(item.VersionId);
          }
          if (versions.length > 10000) throw new Error("Object version count exceeds bounded deletion");
          if (page.IsTruncated && (!page.NextKeyMarker || (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker))) throw new Error("Unverifiable storage pagination");
          KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
        } while (KeyMarker);
        for (const VersionId of versions) await s3.send(new DeleteObjectCommand({ Bucket, Key, VersionId }));
        const remaining = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key, MaxKeys: 1000 }));
        if ([...(remaining.Versions ?? []), ...(remaining.DeleteMarkers ?? [])].some(item => item.Key === Key)) throw new Error("Storage versions remain after deletion");
      } else if (versioning.Status === undefined) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
      else throw new Error("Unsupported storage versioning mode");
      try { await s3.send(new HeadObjectCommand({ Bucket, Key })); throw new Error("Object remains after deletion"); }
      catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error; }
    },
  };
}
