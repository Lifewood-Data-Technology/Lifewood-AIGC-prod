import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  S3Client, GetBucketVersioningCommand, ListObjectsV2Command, ListMultipartUploadsCommand,
  GetObjectCommand, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { assertSeparate, type BackupConfig, type MysqlLocation, type BucketLocation } from "./config.js";
import type { BackupAdapter, DatabaseSummary, ObjectItem, ObjectMeta } from "./engine.js";

const quote = (value: string) => String.fromCharCode(96) + value.replaceAll(String.fromCharCode(96), String.fromCharCode(96, 96)) + String.fromCharCode(96);
async function connect(location: MysqlLocation) {
  return mysql.createConnection({
    host: location.host, port: location.port, database: location.database, user: location.user, password: location.password,
    connectTimeout: 15_000, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
    ...(location.ca ? { ssl: { ca: await readFile(location.ca, "utf8"), rejectUnauthorized: true } } : {}),
  });
}
async function rows(connection: Connection, sql: string, values: unknown[] = []) {
  return (await connection.query<RowDataPacket[]>(sql, values))[0];
}
async function tables(connection: Connection, database: string) {
  const list = await rows(connection, "SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [database]);
  if (list.some(row => row.kind !== "BASE TABLE" || row.engine !== "InnoDB")) throw new Error("UNSUPPORTED_SCHEMA");
  for (const [table, column] of [["TRIGGERS", "TRIGGER_SCHEMA"], ["ROUTINES", "ROUTINE_SCHEMA"], ["EVENTS", "EVENT_SCHEMA"]] as const) {
    if ((await rows(connection, "SELECT 1 FROM information_schema." + table + " WHERE " + column + " = ? LIMIT 1", [database])).length) throw new Error("UNSUPPORTED_SCHEMA");
  }
  if ((await rows(connection, "SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA IS NOT NULL AND REFERENCED_TABLE_SCHEMA <> ? LIMIT 1", [database, database])).length) throw new Error("UNSUPPORTED_SCHEMA");
  return list.map(row => String(row.name));
}
async function summary(connection: Connection, names: string[]): Promise<DatabaseSummary> {
  const version = String((await rows(connection, "SELECT VERSION() AS version"))[0]?.version ?? "");
  if (!/^8\./.test(version) || /mariadb/i.test(version)) throw new Error("UNSUPPORTED_SCHEMA");
  const result: DatabaseSummary = { tables: [], version };
  for (const name of names) {
    const count = String((await rows(connection, "SELECT COUNT(*) AS n FROM " + quote(name)))[0]?.n ?? "");
    const checksum = (await rows(connection, "CHECKSUM TABLE " + quote(name) + " EXTENDED"))[0]?.Checksum;
    if (checksum === null || checksum === undefined || !/^\d+$/.test(count)) throw new Error("UNSUPPORTED_SCHEMA");
    const definition = String((await rows(connection, "SHOW CREATE TABLE " + quote(name)))[0]?.["Create Table"] ?? "");
    if (!definition) throw new Error("UNSUPPORTED_SCHEMA");
    result.tables.push({ name, rows: count, checksum: String(checksum), schemaSha256: createHash("sha256").update(definition).digest("hex") });
  }
  return result;
}

/** Passwords are never command-line arguments, shell input, or log output. */
async function mysqlProcess(binary: string, location: MysqlLocation, args: string[]) {
  const folder = await mkdtemp(join(tmpdir(), "lifewood-backup-client-"));
  const path = join(folder, "client.cnf");
  const escape = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  try {
    await writeFile(path, "[client]\nhost=" + escape(location.host) + "\nport=" + location.port + "\nuser=" + escape(location.user) + "\npassword=" + escape(location.password) + "\n" +
      (location.ca ? "ssl-mode=VERIFY_IDENTITY\nssl-ca=" + escape(location.ca) + "\n" : ""), { mode: 0o600 });
    const child = spawn(binary, ["--defaults-extra-file=" + path, ...args, location.database], {
      shell: false, stdio: ["pipe", "pipe", "pipe"],
      // Do not pass any application/database/storage secrets to subprocesses.
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production" },
    });
    child.stderr.resume();
    let timeout: ReturnType<typeof setTimeout>;
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("MYSQL_TOOL_FAILED")));
      child.once("close", code => code === 0 ? resolve() : reject(new Error("MYSQL_TOOL_FAILED")));
      timeout = setTimeout(() => child.kill("SIGKILL"), 6 * 60 * 60_000);
    }).finally(async () => { clearTimeout(timeout); await rm(folder, { recursive: true, force: true }); });
    // Avoid an unhandled rejection while its stdout is being consumed.
    void done.catch(() => {});
    return { child, done };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}

function storage(location: BucketLocation) {
  return new S3Client({
    endpoint: location.endpoint, region: location.region, forcePathStyle: location.forcePathStyle,
    credentials: { accessKeyId: location.accessKeyId, secretAccessKey: location.secretAccessKey },
    maxAttempts: 3,
  });
}
async function inventory(client: S3Client, bucket: string): Promise<ObjectItem[]> {
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  // Immutable application version keys ARE backed up. Native versioned buckets
  // require a different adapter; never silently export just their latest bytes.
  if (versioning.Status) throw new Error("UNSUPPORTED_BUCKET_VERSIONING");
  const multipart = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, MaxUploads: 1 }));
  if (multipart.Uploads?.length) throw new Error("SOURCE_UPLOADS_PENDING");
  const result: ObjectItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ...(cursor ? { ContinuationToken: cursor } : {}) }));
    for (const item of page.Contents ?? []) {
      if (item.Key === undefined || !item.ETag || !Number.isSafeInteger(item.Size) || item.Size! < 0 || !item.LastModified) throw new Error("INVENTORY_INVALID");
      result.push({ key: item.Key, etag: item.ETag, bytes: item.Size!, modified: item.LastModified.toISOString() });
      if (result.length > 100000) throw new Error("OBJECT_LIMIT");
    }
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!cursor || cursors.has(cursor))) throw new Error("INVENTORY_INVALID");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export class MysqlWasabiAdapter implements BackupAdapter {
  sourceLabel: string; targetLabel: string; restoreConfigured: boolean;
  private sourceStorage: S3Client;
  private targetStorage: S3Client | undefined;
  constructor(private config: BackupConfig) {
    this.sourceLabel = config.sourceLabel; this.targetLabel = config.targetLabel;
    this.restoreConfigured = !!config.target;
    this.sourceStorage = storage(config.source.bucket);
    if (config.target) this.targetStorage = storage(config.target.bucket);
  }
  async lockSource() {
    const connection = await connect(this.config.source.mysql);
    try {
      const names = await tables(connection, this.config.source.mysql.database);
      if (!names.length) throw new Error("SOURCE_EMPTY");
      // Lock only this application's tables; never lock the entire MySQL server.
      await connection.query("SET SESSION lock_wait_timeout = 15");
      await connection.query("LOCK TABLES " + names.map(name => quote(name) + " READ").join(", "));
      const data = await summary(connection, names);
      return { summary: data, validate: async (items: ObjectItem[]) => {
        // ping fails if the read-lock connection has been lost. Never reconnect.
        await connection.ping();
        const observer = await connect(this.config.source.mysql);
        try {
          if (JSON.stringify(names) !== JSON.stringify(await tables(observer, this.config.source.mysql.database))) throw new Error("SOURCE_CHANGED");
        } finally { await observer.end(); }
        if (names.includes("aigc_file_versions") && (await rows(connection, "SELECT 1 FROM aigc_file_versions WHERE upload_status = 'pending' LIMIT 1")).length) throw new Error("SOURCE_UPLOADS_PENDING");
        if (names.includes("direct_upload_sessions") && (await rows(connection, "SELECT 1 FROM direct_upload_sessions WHERE state NOT IN ('ready','cancelled','expired') OR cleaned_at IS NULL LIMIT 1")).length) throw new Error("SOURCE_UPLOADS_PENDING");
        if (names.includes("aigc_storage_objects")) {
          const references = await rows(connection, "SELECT bucket_name, endpoint_url, object_key, state FROM aigc_storage_objects WHERE state NOT IN ('deleted', 'failed', 'purged')");
          const keys = new Set(items.map(item => item.key));
          for (const reference of references) {
            if (reference.bucket_name !== this.config.source.bucket.bucket || String(reference.endpoint_url).replace(/\/$/, "") !== this.config.source.bucket.endpoint) throw new Error("SOURCE_SCOPE_MISMATCH");
            if (!keys.has(String(reference.object_key))) throw new Error("SOURCE_REFERENCE_MISSING");
          }
        }
      }, release: async () => {
        try { await connection.query("UNLOCK TABLES"); } finally { await connection.end(); }
      } };
    } catch (error) { await connection.end(); throw error; }
  }
  async inventory() { return inventory(this.sourceStorage, this.config.source.bucket.bucket); }
  async deployment() {
    const stat = await lstat(this.config.releaseBundle);
    if (!stat.isFile() || stat.size === 0) throw new Error("RELEASE_BUNDLE_REQUIRED");
    return createReadStream(this.config.releaseBundle);
  }
  async dump() {
    const process = await mysqlProcess(this.config.dumpBin, this.config.source.mysql, [
      "--single-transaction", "--quick", "--hex-blob", "--no-tablespaces", "--set-gtid-purged=OFF",
      "--skip-comments", "--skip-add-drop-table", "--skip-add-locks", "--skip-disable-keys", "--skip-triggers",
    ]);
    process.child.stdin.end();
    return { stream: process.child.stdout, done: process.done, cancel: () => { process.child.kill("SIGKILL"); } };
  }
  async readObject(item: ObjectItem) {
    const data = await this.sourceStorage.send(new GetObjectCommand({ Bucket: this.config.source.bucket.bucket, Key: item.key, IfMatch: item.etag }));
    if (!(data.Body instanceof Readable) || data.ContentLength !== item.bytes) throw new Error("OBJECT_UNAVAILABLE");
    return { stream: data.Body, meta: { contentType: data.ContentType ?? "application/octet-stream", metadata: data.Metadata ?? {} } };
  }
  async assertEmptyTarget() {
    const target = this.config.target;
    if (!target || !this.targetStorage) throw new Error("RESTORE_NOT_CONFIGURED");
    assertSeparate(this.config.source, target);
    const connection = await connect(target.mysql);
    try {
      // Unfiltered: views or unexpected tables must also block restoration.
      if ((await rows(connection, "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? LIMIT 1", [target.mysql.database])).length) throw new Error("TARGET_NOT_EMPTY");
      if ((await tables(connection, target.mysql.database)).length) throw new Error("TARGET_NOT_EMPTY");
      if ((await inventory(this.targetStorage, target.bucket.bucket)).length) throw new Error("TARGET_NOT_EMPTY");
    } finally { await connection.end(); }
  }
  async restoreDatabase(stream: Readable) {
    if (!this.config.target) throw new Error("RESTORE_NOT_CONFIGURED");
    const process = await mysqlProcess(this.config.mysqlBin, this.config.target.mysql, ["--binary-mode=1", "--batch", "--local-infile=0"]);
    process.child.stdout.resume();
    try { await pipeline(stream, process.child.stdin); await process.done; }
    catch (error) { process.child.kill("SIGKILL"); await process.done.catch(() => {}); throw error; }
  }
  async targetSummary() {
    if (!this.config.target) throw new Error("RESTORE_NOT_CONFIGURED");
    const connection = await connect(this.config.target.mysql);
    try { return await summary(connection, await tables(connection, this.config.target.mysql.database)); }
    finally { await connection.end(); }
  }
  async writeObject(item: ObjectItem, meta: ObjectMeta, stream: Readable) {
    const client = this.targetStorage; const target = this.config.target;
    if (!client || !target) throw new Error("RESTORE_NOT_CONFIGURED");
    const input = { Bucket: target.bucket.bucket, Key: item.key, ContentType: meta.contentType, Metadata: meta.metadata };
    if (item.bytes === 0) {
      for await (const chunk of stream) { if (Buffer.byteLength(chunk)) throw new Error("CHECKSUM_MISMATCH"); }
      await client.send(new PutObjectCommand({ ...input, Body: Buffer.alloc(0), IfNoneMatch: "*" })); return;
    }
    const size = Math.max(8 * 1024 * 1024, Math.ceil(item.bytes / 9999));
    if (size > 64 * 1024 * 1024) throw new Error("OBJECT_LIMIT");
    const upload = await client.send(new CreateMultipartUploadCommand(input));
    if (!upload.UploadId) throw new Error("OBJECT_UNAVAILABLE");
    const parts: { ETag: string; PartNumber: number }[] = [];
    let buffer = Buffer.alloc(size), used = 0, total = 0;
    const send = async (body: Buffer) => {
      const part = await client.send(new UploadPartCommand({ Bucket: input.Bucket, Key: item.key, UploadId: upload.UploadId!, PartNumber: parts.length + 1, Body: body }));
      if (!part.ETag) throw new Error("OBJECT_UNAVAILABLE");
      parts.push({ ETag: part.ETag, PartNumber: parts.length + 1 });
    };
    try {
      for await (const chunk of stream) {
        const data = Buffer.from(chunk); let offset = 0; total += data.length;
        while (offset < data.length) {
          const n = Math.min(size - used, data.length - offset);
          data.copy(buffer, used, offset, offset + n); used += n; offset += n;
          if (used === size) { await send(buffer); buffer = Buffer.alloc(size); used = 0; }
        }
      }
      if (total !== item.bytes) throw new Error("CHECKSUM_MISMATCH");
      if (used) await send(buffer.subarray(0, used));
      await client.send(new CompleteMultipartUploadCommand({ Bucket: input.Bucket, Key: item.key, UploadId: upload.UploadId, MultipartUpload: { Parts: parts }, IfNoneMatch: "*" }));
    } catch (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: input.Bucket, Key: item.key, UploadId: upload.UploadId })).catch(() => {});
      throw error;
    }
  }
  async readTargetObject(item: ObjectItem) {
    if (!this.config.target || !this.targetStorage) throw new Error("RESTORE_NOT_CONFIGURED");
    const data = await this.targetStorage.send(new GetObjectCommand({ Bucket: this.config.target.bucket.bucket, Key: item.key }));
    if (!(data.Body instanceof Readable)) throw new Error("OBJECT_UNAVAILABLE");
    return data.Body;
  }
}
