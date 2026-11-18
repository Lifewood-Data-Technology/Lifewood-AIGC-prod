export type BusinessDeletionTarget = { id: string; kind: "customer" | "project" };
export type BusinessDeletionReceipt = BusinessDeletionTarget & { submissionId: string; revision: number; previewHash: string; confirmationName: string };
export const businessDeletionReceiptChanged = "lifewood-business-delete-changed";

export function deletionReceiptKey(owner: string, target: BusinessDeletionTarget) {
  return owner ? `lifewood-business-delete:${owner}:${target.kind}:${target.id}` : "";
}

export function isBusinessDeletionReceipt(value: unknown, target: BusinessDeletionTarget): value is BusinessDeletionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.id === target.id && row.kind === target.kind && typeof row.submissionId === "string" && /^[a-z0-9-]{16,100}$/i.test(row.submissionId)
    && typeof row.revision === "number" && Number.isSafeInteger(row.revision) && row.revision > 0
    && typeof row.previewHash === "string" && /^[a-f0-9]{64}$/i.test(row.previewHash) && typeof row.confirmationName === "string" && Boolean(row.confirmationName);
}

/** Receipts identify an earlier attempt; they never grant permission or confirm its result. */
export function pendingBusinessDeletionTargets(owner: string, kind: BusinessDeletionTarget["kind"]): BusinessDeletionTarget[] {
  if (!owner || typeof window === "undefined") return [];
  const prefix = `lifewood-business-delete:${owner}:${kind}:`, targets: BusinessDeletionTarget[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const target = { kind, id: key.slice(prefix.length) };
      if (!target.id) continue;
      try { if (isBusinessDeletionReceipt(JSON.parse(window.localStorage.getItem(key) || "null"), target)) targets.push(target); } catch { /* Invalid data cannot create a recovery entry. */ }
    }
  } catch { /* An inaccessible local store cannot provide recovery identities. */ }
  return targets.sort((left, right) => left.id.localeCompare(right.id));
}

export function notifyBusinessDeletionReceiptsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new window.Event(businessDeletionReceiptChanged));
}
