// Client-only recovery metadata. Credentials and account form contents are never persisted.
const prefix = "lifewood-account-create:";
const ownerPrefix = (owner: string) => `${prefix}${encodeURIComponent(owner.trim().toLowerCase())}:`;
const receiptKey = (owner: string, email: string) => `${ownerPrefix(owner)}${encodeURIComponent(email.trim().toLowerCase())}`;

export function pendingAccountCreations(owner: string): { emails: Record<string, boolean>; storageFailed: boolean } {
  const emails: Record<string, boolean> = {};
  if (typeof window === "undefined") return { emails, storageFailed: false };
  try {
    const store = window.localStorage, scope = ownerPrefix(owner);
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (!key?.startsWith(scope)) continue;
      // Even damaged metadata must not silently unlock an earlier submission.
      const email = decodeURIComponent(key.slice(scope.length));
      if (email) emails[email] = true;
    }
    return { emails, storageFailed: false };
  } catch {
    return { emails, storageFailed: true };
  }
}

/** Persist before sending: leaving the page or losing the response must not permit a new POST. */
export function beginAccountCreation(owner: string, email: string): "started" | "pending" | "storage-failed" {
  try {
    const store = window.localStorage, key = receiptKey(owner, email);
    if (store.getItem(key) !== null) return "pending";
    const metadata = JSON.stringify({ version: 1, startedAt: Date.now() });
    store.setItem(key, metadata);
    return store.getItem(key) === metadata ? "started" : "storage-failed";
  } catch {
    return "storage-failed";
  }
}

/** Only a definite rejection, confirmed success, or an authorized existence check may clear it. */
export function completeAccountCreation(owner: string, email: string): boolean {
  try {
    const store = window.localStorage, key = receiptKey(owner, email);
    store.removeItem(key);
    return store.getItem(key) === null;
  } catch {
    return false;
  }
}
