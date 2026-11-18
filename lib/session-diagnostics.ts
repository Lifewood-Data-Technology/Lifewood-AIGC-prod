/** Classify locally; never emit exception text, stack, SQL, credentials or inputs. */
export function sessionErrorCategory(error: unknown) {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message;
  if (/iterations|iteration count/i.test(message)) return "crypto-cost-unsupported";
  if (/not implemented|not supported|unsupported/i.test(message) && /crypto|pbkdf2/i.test(message)) return "crypto-unavailable";
  if (/no such table|no such column|has no column/i.test(message)) return "database-schema";
  if (/D1_ERROR|SQLITE|database/i.test(message)) return "database-operation";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (error instanceof TypeError) return "type-error";
  if (error instanceof RangeError) return "range-error";
  return "internal-error";
}

/** Request-local diagnostics only: never log email, password, cookies or bodies. */
export async function observeSessionRequest(
  request: Request,
  operation: (phase: (stage: string) => void) => Promise<Response>,
  slowMs = 8_000,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  let stage = "route-enter";
  const event = (outcome: string, status?: number) => ({
    event: "session.request", requestId, method: request.method,
    stage, outcome, durationMs: Date.now() - started, ...(status ? { status } : {}),
  });
  console.info(event("started"));
  const timer = setTimeout(() => console.warn(event("slow")), slowMs);
  const onAbort = () => console.warn(event("client-disconnected"));
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await operation(next => { stage = next; });
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-lifewood-request-id", requestId);
    console.info(event("completed", response.status));
    return response;
  } catch (error) {
    // Internal errors are not credential failures and must not be reported as
    // 401. Keep diagnostic metadata useful without exposing SQL or credentials.
    console.error({ ...event("service-error", 503), category: sessionErrorCategory(error) });
    return Response.json({ error: "Sign-in is temporarily unavailable.", code: "SESSION_SERVICE_UNAVAILABLE", requestId }, {
      status: 503,
      headers: { "cache-control": "no-store", "x-lifewood-request-id": requestId },
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}
