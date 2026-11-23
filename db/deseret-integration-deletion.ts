import { PublicError } from "../lib/security-controls";

export type IntegrationDeletionLocation = { provider: string; bucket: string; endpoint: string; region: string; prefix: string };
type OwnedObject = { key: string; location: IntegrationDeletionLocation; metadataKey: string; owner: string };
type OwnedUpload = OwnedObject & { uploadId: string };
type TaskRow = { project_id?: unknown; direction?: unknown; target_json?: unknown };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function invalid(): never { throw new PublicError("Integration storage inventory requires reconciliation.", 409, "DESERET_DELETION_INVENTORY_UNAVAILABLE"); }
function key(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.split("/").some(segment => !segment || segment === "." || segment === "..")) invalid();
  return value;
}
function location(value: Record<string, unknown>): IntegrationDeletionLocation {
  const { bucket, endpoint, region, prefix } = value;
  if (typeof bucket !== "string" || !bucket || typeof endpoint !== "string" || typeof region !== "string" || !region || typeof prefix !== "string" || prefix && !prefix.endsWith("/")) invalid();
  let url: URL;
  try { url = new URL(endpoint); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid();
  return { provider: "wasabi", bucket, endpoint: url.origin, region, prefix };
}

// Incoming targets and native promotion attempts belong to AIGC. Publisher
// bucket objects stay governed by Deseret's independent retention settings.
export function integrationDeletionInventory(tasks: readonly TaskRow[]) {
  const objects: OwnedObject[] = [], uploads: OwnedUpload[] = [];
  for (const task of tasks) {
    if (task.direction !== "aigc_to_deseret" && task.direction !== "deseret_to_aigc") invalid();
    if (!task.target_json) continue;
    let target: unknown;
    try { target = JSON.parse(String(task.target_json)); } catch { return invalid(); }
    if (!object(target)) invalid();
    if (task.direction === "aigc_to_deseret") {
      if (target.publisherSnapshots === undefined) continue;
      if (!Array.isArray(target.publisherSnapshots)) invalid();
      for (const snapshot of target.publisherSnapshots) {
        if (!object(snapshot) || typeof snapshot.owner !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.owner)) invalid();
        const relative = key(snapshot.key);
        const parts = relative.split("/");
        if (parts.length !== 6 || parts[0] !== "clients" || !/^[A-Za-z0-9_-]{1,120}$/.test(parts[1]) ||
            parts[2] !== "projects" || parts[3] !== task.project_id || parts[4] !== "publisher-review" || parts[5] !== snapshot.owner) invalid();
        const entry = { key: relative, location: location(snapshot), metadataKey: "publisher-source", owner: snapshot.owner };
        objects.push(entry);
        if (snapshot.uploadId !== undefined) {
          if (typeof snapshot.uploadId !== "string" || !snapshot.uploadId || snapshot.uploadId.length > 4096) invalid();
          uploads.push({ ...entry, uploadId: snapshot.uploadId });
        }
      }
      continue;
    }
    if (target.plan !== undefined) {
      if (!object(target.plan) || !object(target.plan.file) || !object(target.plan.target)) invalid();
      const file = target.plan.file, stored = target.plan.target;
      const current = location(stored), relative = key(file.objectKey);
      if (typeof task.project_id !== "string" || !relative.startsWith(`platform-handoffs/${task.project_id}/`)) invalid();
      if (stored.objectKey !== current.prefix + relative || file.storageProfileId !== stored.storageProfileId) invalid();
      if (typeof target.plan.receiptId !== "string" || !target.plan.receiptId) invalid();
      const entry = { key: relative, location: current, metadataKey: "lifewood-transfer", owner: target.plan.receiptId };
      objects.push(entry);
      if (target.peerUploadId !== undefined && target.peerUploadId !== null) {
        if (typeof target.peerUploadId !== "string" || !target.peerUploadId || target.peerUploadId.length > 4096) invalid();
        uploads.push({ ...entry, uploadId: target.peerUploadId });
      }
    } else if (target.objectKey) invalid();
    if (target.nativeAttempts !== undefined) {
      if (!Array.isArray(target.nativeAttempts)) invalid();
      for (const attempt of target.nativeAttempts) {
        if (!object(attempt)) invalid();
        if (typeof attempt.owner !== "string" || !attempt.owner) invalid();
        const entry = { key: key(attempt.objectKey), location: location(attempt), metadataKey: "lifewood-upload-session", owner: attempt.owner };
        objects.push(entry);
        if (attempt.uploadId !== undefined && attempt.uploadId !== null) {
          if (typeof attempt.uploadId !== "string" || !attempt.uploadId || attempt.uploadId.length > 4096) invalid();
          uploads.push({ ...entry, uploadId: attempt.uploadId });
        }
      }
    }
  }
  const unique = <T,>(items: T[]) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];
  return { objects: unique(objects), uploads: unique(uploads) };
}
