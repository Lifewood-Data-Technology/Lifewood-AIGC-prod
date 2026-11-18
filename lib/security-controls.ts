import type { Database } from "../db/database";
/** Only explicitly classified validation errors may reach clients. */
export class PublicError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "INVALID_OPERATION") { super(message); }
}

export class RateLimitError extends PublicError {
  constructor(public readonly retryAfter = 60) { super("Too many requests. Please wait before trying again.", 429, "RATE_LIMITED"); }
}

export async function securityDigest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Fixed windows, atomic reservations, bounded key size; denied requests do not grow rows. */
export async function consumeRateLimit(db: Database, scope: string, identity: string, limit: number, windowMs: number, now = Date.now()) {
  const key = `${scope}:${await securityDigest(identity)}`;
  const result = await db.batch([
    db.prepare("DELETE FROM security_rate_limits WHERE expires_at <= ?").bind(now),
    db.prepare(`INSERT INTO security_rate_limits (key, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = security_rate_limits.count + 1
      WHERE security_rate_limits.count < ? RETURNING count`).bind(key, now + windowMs, limit),
  ]);
  if (!result[1].results.length) throw new RateLimitError(Math.ceil(windowMs / 1000));
}

/** Reserve BEFORE password verification, so concurrent requests cannot overrun the threshold. */
export async function reserveLoginAttempt(db: Database, email: string, lock: boolean, now = new Date()) {
  const at = now.toISOString(), cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const until = new Date(now.getTime() + 15 * 60_000).toISOString();
  const result = await db.prepare(`INSERT INTO login_attempts (email, attempt_count, first_attempt_at, locked_until, updated_at)
    VALUES (?, 1, ?, NULL, ?) ON CONFLICT(email) DO UPDATE SET
    attempt_count = CASE WHEN login_attempts.first_attempt_at <= ? THEN 1 ELSE login_attempts.attempt_count + 1 END,
    first_attempt_at = CASE WHEN login_attempts.first_attempt_at <= ? THEN excluded.first_attempt_at ELSE login_attempts.first_attempt_at END,
    locked_until = CASE WHEN ? AND login_attempts.first_attempt_at > ? AND login_attempts.attempt_count >= 4 THEN ? ELSE NULL END,
    updated_at = excluded.updated_at
    WHERE NOT ? OR ((login_attempts.locked_until IS NULL OR login_attempts.locked_until <= ?)
      AND (login_attempts.first_attempt_at <= ? OR login_attempts.attempt_count < 5)) RETURNING attempt_count`)
    .bind(email, at, at, cutoff, cutoff, lock ? 1 : 0, cutoff, until, lock ? 1 : 0, at, cutoff).first();
  if (!result) throw new PublicError("LOGIN_TEMPORARILY_LOCKED", 429, "LOGIN_TEMPORARILY_LOCKED");
}

/** Small JSON requests are bounded even without Content-Length. */
export async function readBoundedJson(request: Request, maxBytes = 16_384): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError("Invalid request body.");
  let bytes = 0, text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new PublicError("Request body is too large.", 413, "BODY_TOO_LARGE"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError("Invalid request body.");
  } finally { reader.releaseLock(); }
}
