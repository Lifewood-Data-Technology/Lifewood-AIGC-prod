/** Legacy browser marker, NOT a session, proof of closure, or a password substitute.
 * Kept for compatibility only: the server must never use this value to replace
 * an active owner. Recovery requires an authenticated close or the original tab proof.
 */
const storageKey = "lifewood-browser-recovery-v1";
export function browserRecoveryKey(): string {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored && /^[a-f0-9]{64}$/.test(stored)) return stored;
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(storageKey, key);
    return key;
  } catch { return ""; }
}
