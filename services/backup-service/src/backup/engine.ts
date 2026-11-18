import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backupIdPattern, validBackupCommand, type BackupCommand, type BackupJob, type BackupStatus } from "./contract.js";
import { inspect, meter, readManifest, seal, sink, unseal, type Digest } from "./vault.js";

export type ObjectItem = { key: string; etag: string; bytes: number; modified: string };
export type DatabaseSummary = { tables: { name: string; rows: string; checksum: string; schemaSha256: string }[]; version: string };
export type ObjectMeta = { contentType: string; metadata: Record<string, string> };
export interface BackupAdapter {
  sourceLabel: string;
  targetLabel: string;
  restoreConfigured: boolean;
  // This lease must hold the source database read lock until release().
  lockSource(): Promise<{ summary: DatabaseSummary; validate?(inventory: ObjectItem[]): Promise<void>; release(): Promise<void> }>;
  inventory(): Promise<ObjectItem[]>;
  deployment(): Promise<Readable>;
  dump(): Promise<{ stream: Readable; done: Promise<void>; cancel(): void }>;
  readObject(item: ObjectItem): Promise<{ stream: Readable; meta: ObjectMeta }>;
  assertEmptyTarget(): Promise<void>;
  restoreDatabase(stream: Readable): Promise<void>;
  writeObject(item: ObjectItem, meta: ObjectMeta, stream: Readable): Promise<void>;
  readTargetObject(item: ObjectItem): Promise<Readable>;
  targetSummary(): Promise<DatabaseSummary>;
}
type Entry = Digest & { file: string; object?: ObjectItem; meta?: ObjectMeta };
type Manifest = {
  format: 1; id: string; createdAt: string; sourceLabel: string;
  database: DatabaseSummary; entries: Entry[];
};
const timestamp = () => new Date().toISOString();
const running = (job: BackupJob) => job.state === "queued" || job.state === "running";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const safeCodes = new Set([
  "SOURCE_CHANGED", "SOURCE_EMPTY", "UNSUPPORTED_SCHEMA", "UNSUPPORTED_BUCKET_VERSIONING",
  "TARGET_NOT_EMPTY", "TARGET_NOT_ISOLATED", "RESTORE_NOT_CONFIGURED", "ARCHIVE_INVALID",
  "CHECKSUM_MISMATCH", "DATABASE_MISMATCH", "OBJECT_LIMIT", "MAINTENANCE_REQUIRED",
  "MYSQL_TOOL_FAILED", "OBJECT_UNAVAILABLE", "INVENTORY_INVALID", "SOURCE_UPLOADS_PENDING", "SOURCE_REFERENCE_MISSING", "SOURCE_SCOPE_MISMATCH", "MANIFEST_TOO_LARGE", "RELEASE_BUNDLE_REQUIRED",
]);

export class BackupEngine {
  private jobs: BackupJob[] = [];
  private active: Promise<void> | undefined;
  constructor(private root: string, private key: Buffer, private adapter: BackupAdapter) {
    if (key.length !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (!name.endsWith(".job.json") || !backupIdPattern.test(name.slice(0, -9))) continue;
      const job = JSON.parse(await readFile(join(this.root, name), "utf8")) as BackupJob;
      if (!backupIdPattern.test(job.id) || job.id !== name.slice(0, -9)) throw new Error("JOB_INVALID");
      if (running(job)) { job.state = "interrupted"; job.stage = "interrupted"; job.updatedAt = timestamp(); await this.persist(job); }
      this.jobs.push(job);
    }
  }
  status(): BackupStatus {
    return {
      configured: true, provider: "mysql-wasabi", restoreConfigured: this.adapter.restoreConfigured,
      sourceLabel: this.adapter.sourceLabel, targetLabel: this.adapter.targetLabel,
      jobs: [...this.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => ({ ...job })),
    };
  }
  private async persist(job: BackupJob) {
    const path = join(this.root, job.id + ".job.json");
    await writeFile(path + ".tmp", JSON.stringify(job), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  async submit(body: BackupCommand, actor: string): Promise<BackupJob> {
    if (!validBackupCommand(body)) throw new Error("INVALID_COMMAND");
    const previous = this.jobs.find(job => job.id === body.requestId);
    if (previous) {
      if (previous.operation !== body.operation || previous.backupId !== body.backupId || previous.actor !== actor) throw new Error("IDEMPOTENCY_CONFLICT");
      return { ...previous };
    }
    if (this.jobs.some(running)) throw new Error("JOB_BUSY");
    if (body.operation === "restore" && !this.adapter.restoreConfigured) throw new Error("RESTORE_NOT_CONFIGURED");
    if (body.operation !== "backup" && !this.jobs.some(job => job.id === body.backupId && job.operation === "backup" && job.state === "completed")) throw new Error("BACKUP_NOT_READY");
    const job: BackupJob = {
      id: body.requestId, operation: body.operation, ...(body.backupId ? { backupId: body.backupId } : {}),
      state: "queued", stage: "queued", createdAt: timestamp(), updatedAt: timestamp(),
      actor, objects: 0, bytes: 0, tables: 0,
    };
    // Reserve synchronously before the first await: double clicks cannot race.
    this.jobs.push(job);
    try { await this.persist(job); } catch (error) { job.state = "failed"; throw error; }
    this.active = this.run(job);
    return { ...job };
  }
  async idle() { await this.active; }
  private async update(job: BackupJob, stage: string) {
    job.stage = stage; job.updatedAt = timestamp(); await this.persist(job);
  }
  private path(id: string, file: string) {
    if (!backupIdPattern.test(id) || !/^(database|deployment|manifest|object-[0-9]{6})\.enc$/.test(file)) throw new Error("ARCHIVE_INVALID");
    return join(this.root, id, file);
  }
  private async manifest(id: string): Promise<Manifest> {
    const value = await readManifest(this.path(id, "manifest.enc"), this.key) as Manifest;
    if (value.format !== 1 || value.id !== id || !Array.isArray(value.entries) || value.entries.length < 2 || value.entries.length > 100002 ||
        value.entries[0]?.file !== "database.enc" || value.entries[1]?.file !== "deployment.enc" || !Array.isArray(value.database?.tables)) throw new Error("ARCHIVE_INVALID");
    const names = new Set<string>();
    for (const entry of value.entries) {
      this.path(id, entry.file);
      if (names.has(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("ARCHIVE_INVALID");
      names.add(entry.file);
    }
    return value;
  }
  private async verify(job: BackupJob, manifest: Manifest) {
    await this.update(job, "verifying");
    for (const entry of manifest.entries) {
      if (!same(await inspect(this.path(manifest.id, entry.file), this.key), { sha256: entry.sha256, bytes: entry.bytes })) throw new Error("CHECKSUM_MISMATCH");
      job.bytes += entry.bytes;
      if (entry.object) job.objects++;
      await this.update(job, "verifying");
    }
    job.tables = manifest.database.tables.length;
  }
  private async backup(job: BackupJob) {
    await mkdir(join(this.root, job.id), { mode: 0o700 });
    await this.update(job, "locking");
    const lease = await this.adapter.lockSource();
    try {
      if (!lease.summary.tables.length) throw new Error("SOURCE_EMPTY");
      job.tables = lease.summary.tables.length;
      const inventory = await this.adapter.inventory();
      await lease.validate?.(inventory);
      const manifest: Manifest = { format: 1, id: job.id, createdAt: timestamp(), sourceLabel: this.adapter.sourceLabel, database: lease.summary, entries: [] };
      await this.update(job, "database");
      const dump = await this.adapter.dump();
      try {
        const digest = await seal(dump.stream, this.path(job.id, "database.enc"), this.key);
        await dump.done;
        manifest.entries.push({ file: "database.enc", ...digest }); job.bytes += digest.bytes;
      } catch (error) { dump.cancel(); await dump.done.catch(() => {}); throw error; }
      const deployment = await seal(await this.adapter.deployment(), this.path(job.id, "deployment.enc"), this.key);
      manifest.entries.push({ file: "deployment.enc", ...deployment }); job.bytes += deployment.bytes;
      await this.update(job, "files");
      for (const [index, item] of inventory.entries()) {
        const object = await this.adapter.readObject(item);
        const file = "object-" + String(index).padStart(6, "0") + ".enc";
        const digest = await seal(object.stream, this.path(job.id, file), this.key);
        if (digest.bytes !== item.bytes) throw new Error("SOURCE_CHANGED");
        manifest.entries.push({ file, ...digest, object: item, meta: object.meta });
        job.objects++; job.bytes += digest.bytes;
        await this.update(job, "files");
      }
      if (!same(inventory, await this.adapter.inventory())) throw new Error("SOURCE_CHANGED");
      await lease.validate?.(inventory);
      const encoded = JSON.stringify(manifest);
      if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error("MANIFEST_TOO_LARGE");
      await seal(Readable.from([encoded]), this.path(job.id, "manifest.enc"), this.key);
      job.bytes = 0; job.objects = 0;
      await this.verify(job, manifest);
    } finally { await lease.release(); }
  }
  private async restore(job: BackupJob, manifest: Manifest) {
    // Fully authenticate every encrypted file BEFORE touching the target.
    await this.verify(job, manifest);
    await this.update(job, "checking-target");
    await this.adapter.assertEmptyTarget();
    await this.update(job, "restoring-database");
    await this.adapter.restoreDatabase(await unseal(this.path(manifest.id, "database.enc"), this.key));
    if (!same(manifest.database.tables, (await this.adapter.targetSummary()).tables)) throw new Error("DATABASE_MISMATCH");
    await this.update(job, "restoring-files");
    for (const entry of manifest.entries) {
      if (!entry.object || !entry.meta) continue;
      await this.adapter.writeObject(entry.object, entry.meta, await unseal(this.path(manifest.id, entry.file), this.key));
      const digest = meter();
      await pipeline(await this.adapter.readTargetObject(entry.object), digest.stream, sink());
      if (!same(digest.result(), { sha256: entry.sha256, bytes: entry.bytes })) throw new Error("CHECKSUM_MISMATCH");
    }
  }
  private async run(job: BackupJob) {
    try {
      job.state = "running";
      if (job.operation === "backup") await this.backup(job);
      else {
        const manifest = await this.manifest(job.backupId!);
        if (job.operation === "verify") await this.verify(job, manifest);
        else await this.restore(job, manifest);
      }
      job.state = "completed";
      await this.update(job, job.operation === "restore" ? "awaiting-acceptance" : "completed");
    } catch (error) {
      job.state = "failed";
      const code = error instanceof Error ? error.message : "";
      job.error = safeCodes.has(code) ? code : "BACKUP_OPERATION_FAILED";
      await this.update(job, "failed").catch(() => {});
    }
  }
}
