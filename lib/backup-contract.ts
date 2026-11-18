export type BackupJob = {
  id: string;
  operation: "backup" | "verify" | "restore";
  backupId?: string;
  state: "queued" | "running" | "completed" | "failed" | "interrupted";
  stage: string;
  createdAt: string;
  updatedAt: string;
  actor: string;
  objects: number;
  bytes: number;
  tables: number;
  error?: string;
};

export type BackupStatus = {
  configured: boolean;
  provider: "mysql-wasabi" | "not-configured";
  restoreConfigured: boolean;
  sourceLabel: string;
  targetLabel: string;
  jobs: BackupJob[];
};

export type BackupCommand = {
  requestId: string;
  operation: BackupJob["operation"];
  backupId?: string;
  confirmation: string;
  writesPaused?: boolean;
  targetIsolated?: boolean;
};

export const backupIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validBackupCommand(body: unknown): body is BackupCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as BackupCommand;
  if (!backupIdPattern.test(b.requestId ?? "")) return false;
  if (!["backup", "verify", "restore"].includes(b.operation)) return false;
  if (b.confirmation !== b.operation.toUpperCase()) return false;
  if (b.operation !== "backup" && !backupIdPattern.test(b.backupId ?? "")) return false;
  if (b.operation === "backup" && b.writesPaused !== true) return false;
  if (b.operation === "restore" && b.targetIsolated !== true) return false;
  return true;
}
