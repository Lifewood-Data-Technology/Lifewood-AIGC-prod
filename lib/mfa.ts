import type { Database } from "../db/database";
import { consumeRateLimit, PublicError, securityDigest } from "./security-controls";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const encode = (bytes: Uint8Array) => { let bits = 0, value = 0, result = ""; for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) result += alphabet[(value << (5 - bits)) & 31]; return result; };
const decode = (value: string) => { let bits = 0, buffer = 0; const bytes: number[] = []; for (const char of value) { const n = alphabet.indexOf(char); if (n < 0) throw new Error("Invalid MFA secret"); buffer = (buffer << 5) | n; bits += 5; if (bits >= 8) { bytes.push((buffer >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(bytes); };
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => Uint8Array.from(value.match(/.{2}/g) || [], part => parseInt(part, 16));
const equal = (a: string, b: string) => { let difference = a.length ^ b.length; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return difference === 0; };
export const mfaReady = (key: string) => /^[a-f0-9]{64}$/i.test(key);
export function newMfaSecret() { return encode(crypto.getRandomValues(new Uint8Array(20))); }

/** RFC 6238 / RFC 4226. Uses the platform HMAC primitive, not custom cryptography. */
export async function totp(secret: string, counter: number, digits = 6) {
  const key = await crypto.subtle.importKey("raw", decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const message = new Uint8Array(8); new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1] & 15;
  const number = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(number % (10 ** digits)).padStart(digits, "0");
}
async function matchingCounter(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return -1;
  const counter = Math.floor(now / 30_000);
  for (const delta of [0, -1, 1]) if (equal(await totp(secret, counter + delta), code)) return counter + delta;
  return -1;
}

/** Secret key must live in runtime secrets, never alongside the ciphertext in the database. */
async function sealKey(key: string) {
  if (!mfaReady(key)) throw new PublicError("MFA protection is not configured. Contact the site owner.", 503, "MFA_UNAVAILABLE");
  return crypto.subtle.importKey("raw", unhex(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(secret: string, email: string, key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(email) }, await sealKey(key), new TextEncoder().encode(secret));
  return hex(iv) + ":" + hex(new Uint8Array(bytes));
}
async function unseal(value: string, email: string, key: string) {
  const [iv, ciphertext] = value.split(":");
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(iv), additionalData: new TextEncoder().encode(email) }, await sealKey(key), unhex(ciphertext));
  return new TextDecoder().decode(bytes);
}
type MfaRow = { account_email: string; secret_enc: string; generation: string; enabled_at: string; pending_expires_at: string; last_counter: number; recovery_hashes: string };
export function readMfa(db: Database, email: string) { return db.prepare("SELECT * FROM account_mfa WHERE account_email = ?").bind(email).first<MfaRow>(); }
export async function mfaStatus(db: Database, email: string, key: string) {
  const row = await readMfa(db, email);
  return { enabled: Boolean(row?.enabled_at), configured: mfaReady(key), recoveryRemaining: row?.enabled_at ? (JSON.parse(row.recovery_hashes) as string[]).length : 0 };
}
const invalid = () => new PublicError("The verification code is invalid, expired or already used.", 401, "MFA_INVALID");
async function codes(email: string) {
  const plain = Array.from({ length: 10 }, () => hex(crypto.getRandomValues(new Uint8Array(16))).match(/.{4}/g)!.join("-"));
  const hashes = await Promise.all(plain.map(code => securityDigest(email + ":" + code.replaceAll("-", ""))));
  return { plain, hashes: JSON.stringify(hashes) };
}
async function consumeCode(db: Database, row: MfaRow, key: string, raw: string) {
  const code = raw.replace(/[\s-]/g, "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(code)) {
    const hash = await securityDigest(row.account_email + ":" + code);
    const hashes = JSON.parse(row.recovery_hashes) as string[];
    if (!hashes.some(item => equal(hash, item))) throw invalid();
    const result = await db.prepare("UPDATE account_mfa SET recovery_hashes = ? WHERE account_email = ? AND generation = ? AND enabled_at <> '' AND recovery_hashes = ?")
      .bind(JSON.stringify(hashes.filter(item => !equal(item, hash))), row.account_email, row.generation, row.recovery_hashes).run();
    if (result.meta.changes !== 1) throw invalid();
    return;
  }
  const counter = await matchingCounter(await unseal(row.secret_enc, row.account_email, key), code);
  if (counter < 0 || counter <= row.last_counter) throw invalid();
  const result = await db.prepare("UPDATE account_mfa SET last_counter = ? WHERE account_email = ? AND generation = ? AND enabled_at <> '' AND last_counter < ?")
    .bind(counter, row.account_email, row.generation, counter).run();
  if (result.meta.changes !== 1) throw invalid();
}

export async function verifyLoginMfa(db: Database, email: string, key: string, code: string, sameTab: boolean) {
  const row = await readMfa(db, email);
  if (!row?.enabled_at) return "";
  // Retrying a lost response in the already-authenticated tab cannot consume an OTP twice.
  if (!sameTab) {
    if (!code) throw new PublicError("Enter your authenticator code or a recovery code.", 401, "MFA_REQUIRED");
    await consumeRateLimit(db, "mfa-login", email, 5, 15 * 60_000);
    await consumeCode(db, row, key, code);
  }
  return row.generation;
}

/** Caller must already have authenticated this administrator and re-verified their password. */
export async function manageMfa(db: Database, email: string, key: string, action: string, code: string, currentTokenHash: string) {
  const row = await readMfa(db, email);
  if (action === "start") {
    if (row?.enabled_at) throw new PublicError("Disable the current authenticator before replacing it.");
    const secret = newMfaSecret(), encrypted = await seal(secret, email, key), generation = crypto.randomUUID();
    const result = await db.prepare(`INSERT INTO account_mfa (account_email, secret_enc, generation, enabled_at, pending_expires_at, last_counter, recovery_hashes)
      VALUES (?, ?, ?, '', ?, -1, '[]') ON CONFLICT(account_email) DO UPDATE SET secret_enc = excluded.secret_enc,
      generation = excluded.generation, pending_expires_at = excluded.pending_expires_at, last_counter = -1, recovery_hashes = '[]' WHERE enabled_at = ''`)
      .bind(email, encrypted, generation, new Date(Date.now() + 10 * 60_000).toISOString()).run();
    if (result.meta.changes !== 1) throw new PublicError("MFA settings changed. Refresh before continuing.", 409);
    return { secret, expiresIn: 600 };
  }
  if (action === "confirm") {
    if (!row || row.enabled_at || Date.parse(row.pending_expires_at) <= Date.now()) throw new PublicError("Enrollment expired or changed. Start again.", 409, "MFA_ENROLLMENT_EXPIRED");
    const counter = await matchingCounter(await unseal(row.secret_enc, email, key), code);
    if (counter < 0) throw invalid();
    const recovery = await codes(email);
    const result = await db.batch([
      db.prepare("UPDATE account_mfa SET enabled_at = ?, pending_expires_at = '', last_counter = ?, recovery_hashes = ? WHERE account_email = ? AND generation = ? AND enabled_at = ''")
        .bind(new Date().toISOString(), counter, recovery.hashes, email, row.generation),
      db.prepare("UPDATE account_sessions SET revoked_reason = 'policy_upgrade' WHERE account_email = ? AND token_hash <> ? AND revoked_reason = '' AND EXISTS (SELECT 1 FROM account_mfa WHERE account_email = ? AND enabled_at <> '')")
        .bind(email, currentTokenHash, email),
    ]);
    if (result[0].meta.changes !== 1) throw new PublicError("MFA settings changed. Refresh before continuing.", 409);
    return { enabled: true, recoveryCodes: recovery.plain };
  }
  if (!row?.enabled_at || !["disable", "recovery"].includes(action)) throw new PublicError("Unsupported MFA operation.");
  await consumeCode(db, row, key, code);
  if (action === "disable") {
    const result = await db.prepare("DELETE FROM account_mfa WHERE account_email = ? AND generation = ?").bind(email, row.generation).run();
    if (result.meta.changes !== 1) throw new PublicError("MFA settings changed. Refresh before continuing.", 409);
    return { enabled: false };
  }
  const recovery = await codes(email);
  const result = await db.prepare("UPDATE account_mfa SET recovery_hashes = ?, generation = ? WHERE account_email = ? AND generation = ? AND enabled_at <> ''")
    .bind(recovery.hashes, crypto.randomUUID(), email, row.generation).run();
  if (result.meta.changes !== 1) throw new PublicError("MFA settings changed. Refresh before continuing.", 409);
  return { enabled: true, recoveryCodes: recovery.plain };
}
