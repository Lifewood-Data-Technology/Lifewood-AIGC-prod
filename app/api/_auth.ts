import { PublicError, RateLimitError } from "../../lib/security-controls";
import {UploadAdmissionError} from '../../lib/upload-admission-error';

export function authenticatedEmail(request: Request) {
  const email = request.headers.get("x-lifewood-actor-email");
  if (!email) throw new Error("AUTH_REQUIRED");
  return email;
}

export function apiError(error: unknown, fallback: string, defaultStatus = 400) {
  const isAuthenticationError = error instanceof Error && error.message === "AUTH_REQUIRED";
  const known = error instanceof PublicError;
  const requestId = crypto.randomUUID();
  if (!known && !isAuthenticationError) {
    const code = (error as { code?: unknown } | null)?.code;
    // Log only a bounded driver classification, never SQL, bound values or SDK responses.
    const category = typeof code === "string" && /^(?:ER_[A-Z_]+|MYSQL_BATCH_BUSY)$/.test(code) ? code : "UNCLASSIFIED";
    // The error class or SDK error name only (e.g. TypeError, TimeoutError, NotImplemented): never its message.
    const name = error instanceof Error ? error.name : typeof error;
    const errorName = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "Unknown";
    console.error({ event: "api.internal_error", requestId, category, errorName });
  }
  const message = isAuthenticationError ? "Authentication is required." : known ? error.message : fallback;
  return Response.json(
    { error: message, ...(known ? { code: error.code } : { requestId }),...(error instanceof UploadAdmissionError?{reasonCode:error.reasonCode}:{}) },
    {
      status: isAuthenticationError ? 401 : known ? (error.status === 400 ? defaultStatus : error.status) : 500,
      headers: { "cache-control": "no-store", ...(error instanceof RateLimitError ? { "retry-after": String(error.retryAfter) } : {}) },
    },
  );
}
