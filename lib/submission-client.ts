import { browserRandomUUID } from "./browser-crypto";
import { canonicalSubmission, protectedCreates, submissionDigest } from "./submission-policy";
let owner = "";
export function setSubmissionOwner(email: string) { if (owner !== email) memory.clear(); owner = email; }
const memory = new Map<string, { id: string; warning: symbol; acknowledged: boolean }>();
export const hasUnconfirmedSubmission = () => memory.size > 0;
export const unacknowledgedSubmissionWarnings = () => [...memory.values()].filter(item => !item.acknowledged).map(item => item.warning);
/** A menu confirmation acknowledges only those attempts, never their result or retry IDs. */
export function acknowledgeSubmissionWarnings(warnings: readonly symbol[]) {
  const accepted = new Set(warnings);
  for (const item of memory.values()) if (accepted.has(item.warning)) item.acknowledged = true;
}

export async function submissionTicket(body: BodyInit | null | undefined) {
  if (typeof body !== "string") return null;
  let parsed: { action?: string; payload?: Record<string, string> };
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed.action || !protectedCreates.has(parsed.action)) return null;
  const key = "lifewood-submit:" + owner + ":" + await submissionDigest(canonicalSubmission(parsed.action, parsed.payload || {}));
  let id = memory.get(key)?.id;
  try { id ||= window.localStorage.getItem(key) || undefined; } catch { /* Retain in this page if storage is blocked. */ }
  id ||= browserRandomUUID();
  // Retrying the same payload reuses its idempotency ID but starts a new warning.
  const attempt = { id, warning: Symbol(), acknowledged: false };
  memory.set(key, attempt);
  try { window.localStorage.setItem(key, id); } catch { /* The form draft displays browser-storage failures. */ }
  return { id, complete: () => {
    if (memory.get(key) !== attempt) return; // An older response must not settle a newer attempt/account.
    memory.delete(key);
    try { window.localStorage.removeItem(key); } catch { /* Safe duplicate replay remains server-side. */ }
  } };
}
