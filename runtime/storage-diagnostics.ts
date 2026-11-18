import type {S3Client} from "@aws-sdk/client-s3";

type Source = "application" | "regression";
const commands = new Set(["HeadObjectCommand", "GetObjectCommand", "PutObjectCommand", "DeleteObjectCommand", "DeleteObjectsCommand", "ListObjectsV2Command", "ListObjectVersionsCommand", "GetBucketVersioningCommand", "ListMultipartUploadsCommand", "CreateMultipartUploadCommand", "UploadPartCommand", "UploadPartCopyCommand", "ListPartsCommand", "CompleteMultipartUploadCommand", "AbortMultipartUploadCommand", "CopyObjectCommand"]);
const reasons = new Set(["AbortError", "TimeoutError", "RequestTimeout", "AccessDenied", "NoSuchKey", "NoSuchUpload", "NotFound", "PreconditionFailed", "InvalidPart", "BadDigest", "ChecksumMismatch", "NetworkingError", "InternalError", "ServiceUnavailable", "SlowDown"]);

/** Only operation names, timing and bounded SDK status; never errors, arguments, URLs or object keys. */
export function reportStorageFailure(source: Source, command: string | undefined, error: unknown, started: number, phase: "request" | "body" = "request") {
  try {
    const value = error as {name?: unknown; code?: unknown; cause?: {code?: unknown}; $metadata?: {httpStatusCode?: unknown; attempts?: unknown}} | null;
    const transportCodes = new Set(['ECONNRESET','EPIPE','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN']);
    const transportCode = [value?.code, value?.cause?.code].find(code => typeof code === 'string' && transportCodes.has(code));
    const status = value?.$metadata?.httpStatusCode, attempts = value?.$metadata?.attempts;
    // Missing objects/uploads are normal existence probes in recovery and deletion.
    if (status === 404 && ["NotFound", "NoSuchKey", "NoSuchUpload"].includes(String(value?.name))) return;
    console.warn(JSON.stringify({event: "storage.operation.failed", source, command: commands.has(command || "") ? command : "UnknownCommand", phase,
      reason: typeof value?.name === "string" && reasons.has(value.name) ? value.name : "UNCLASSIFIED",
      ...(transportCode ? {transportCode} : {}),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? {status} : {}),
      ...(Number.isInteger(attempts) && Number(attempts) >= 1 && Number(attempts) <= 100 ? {attempts} : {})}));
  } catch { /* Diagnostic failures cannot replace the original outcome. */ }
}

/** Observe the original single-attempt request; no retry, timeout or authorization changes. */
export function installStorageDiagnostics(client: S3Client, source: Source) {
  client.middlewareStack.add((next, context) => async args => {
    const started = performance.now();
    try { return await next(args); }
    catch (error) { reportStorageFailure(source, context.commandName, error, started); throw error; }
  }, {name: "lifewoodStorageDiagnostics", step: "initialize"});
}
