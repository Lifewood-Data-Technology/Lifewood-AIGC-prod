import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export type MysqlLocation = { host: string; port: number; database: string; user: string; password: string; ca?: string };
export type BucketLocation = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
export type BackupConfig = {
  root: string; key: Buffer; token: string; host: string; port: number;
  source: { mysql: MysqlLocation; bucket: BucketLocation };
  target?: { mysql: MysqlLocation; bucket: BucketLocation };
  mysqlBin: string; dumpBin: string; sourceLabel: string; targetLabel: string;
  releaseBundle: string;
};

export function loadBackupConfig(values = process.env): BackupConfig {
  const get = (name: string) => {
    const value = values[name];
    if (!value || /[\r\n\0]/.test(value)) throw new Error("Missing or invalid setting: " + name);
    return value;
  };
  const local = values.BACKUP_ALLOW_LOCAL === "true";
  const port = (key: string, fallback: number) => {
    const value = Number(values[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Invalid port: " + key);
    return value;
  };
  const mysql = (prefix: string): MysqlLocation => {
    const database = get(prefix + "_DATABASE");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database) || ["mysql", "sys", "information_schema", "performance_schema"].includes(database.toLowerCase())) throw new Error("Invalid application database");
    const ca = values[prefix + "_TLS_CA"];
    if (!local && !ca) throw new Error("MySQL TLS CA is required outside local testing");
    return { host: get(prefix + "_HOST"), port: port(prefix + "_PORT", 3306), database, user: get(prefix + "_USER"), password: get(prefix + "_PASSWORD"), ...(ca ? { ca } : {}) };
  };
  const bucket = (prefix: string): BucketLocation => {
    const endpoint = new URL(get(prefix + "_ENDPOINT"));
    if ((!local && endpoint.protocol !== "https:") || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname)) throw new Error("Invalid S3 endpoint");
    const name = get(prefix + "_BUCKET");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) throw new Error("Invalid bucket name");
    return { endpoint: endpoint.origin, region: get(prefix + "_REGION"), bucket: name, accessKeyId: get(prefix + "_ACCESS_KEY_ID"), secretAccessKey: get(prefix + "_SECRET_ACCESS_KEY"), forcePathStyle: values[prefix + "_FORCE_PATH_STYLE"] === "true" };
  };
  const root = get("BACKUP_DIRECTORY");
  if (!isAbsolute(root) || ["/", homedir(), process.cwd()].includes(resolve(root))) throw new Error("Use a dedicated absolute backup directory");
  const key = get("BACKUP_ENCRYPTION_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("BACKUP_ENCRYPTION_KEY must be a 32-byte hex key");
  const token = get("BACKUP_SERVICE_TOKEN");
  if (token.length < 32) throw new Error("BACKUP_SERVICE_TOKEN is too short");
  const releaseBundle = get("BACKUP_RELEASE_BUNDLE");
  if (!isAbsolute(releaseBundle)) throw new Error("BACKUP_RELEASE_BUNDLE must be an absolute file path");
  const source = { mysql: mysql("BACKUP_SOURCE_MYSQL"), bucket: bucket("BACKUP_SOURCE_WASABI") };
  const target = values.BACKUP_RESTORE_ENABLED === "true"
    ? { mysql: mysql("BACKUP_TARGET_MYSQL"), bucket: bucket("BACKUP_TARGET_WASABI") } : undefined;
  if (target) assertSeparate(source, target);
  return {
    root: resolve(root), key: Buffer.from(key, "hex"), token, source, releaseBundle, ...(target ? { target } : {}),
    host: values.BACKUP_HOST ?? "127.0.0.1", port: port("BACKUP_PORT", 8789),
    mysqlBin: values.BACKUP_MYSQL_BIN ?? "mysql", dumpBin: values.BACKUP_MYSQLDUMP_BIN ?? "mysqldump",
    sourceLabel: values.BACKUP_SOURCE_LABEL ?? "MySQL / Wasabi",
    targetLabel: target ? (values.BACKUP_TARGET_LABEL ?? "Isolated verification environment") : "",
  };
}

export function assertSeparate(source: BackupConfig["source"], target: NonNullable<BackupConfig["target"]>) {
  // Reject same names even across hosts/endpoints: aliases must never allow
  // the operator to mistake the source for a restore target.
  if (source.mysql.database.toLowerCase() === target.mysql.database.toLowerCase() ||
      source.mysql.user === target.mysql.user || source.bucket.bucket === target.bucket.bucket ||
      source.bucket.accessKeyId === target.bucket.accessKeyId) throw new Error("TARGET_NOT_ISOLATED");
}
