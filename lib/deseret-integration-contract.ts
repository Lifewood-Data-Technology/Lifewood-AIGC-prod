// Server-only integration metadata and authentication. Storage credentials stay in
// their owning platform and never form part of this protocol.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_INTEGRATION_BODY_BYTES = 1024 * 1024;
export const INTEGRATION_CLOCK_SKEW_SECONDS = 300;
const protocol = "LW-INTEGRATION-V1";
const identityPattern = /^[A-Za-z0-9_-]{1,120}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export type IntegrationService = "deseret" | "aigc";
export type IntegrationConfig = {
  enabled: boolean;
  peerBaseUrl: string;
  allowLoopbackHttp: boolean;
  incomingKeyId: string;
  incomingSecret: string;
  outgoingKeyId: string;
  outgoingSecret: string;
  clientId: string;
  intakeOwnerEmail: string;
  intakeDueDays: number;
};
export type HandoffMaterial = {
  id: string;
  version: number;
  size: number;
  sha256?: string;
  integrity?: { algorithm: "sha256" | "wasabi-sha256-parts-v1"; value: string };
  purpose: string;
  storageProfileId: string;
  objectKey: string;
  name: string;
  mimeType: string;
};
const integrationEventTypes = [
  "project.handoff",
  "project.accepted",
  "project.delivered",
  "project.archived",
  "materials.ready",
  "materials.failed",
  "review.published",
  "review.withdrawn",
  "intake.supplement_requested",
  "review.concluded",
  "review.feedback",
  "author.feedback",
] as const;
export type IntegrationEnvelope = {
  schemaVersion: 1;
  eventId: string;
  type: typeof integrationEventTypes[number];
  projectId: string;
  sourceRevision: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && identityPattern.test(value);
}
function validSecret(value: string) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 32 && value.length <= 4096;
}

export function integrationPeerOrigin(value: string, allowLoopbackHttp = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw Error("Invalid integration peer origin"); }
  const localHttp = allowLoopbackHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw Error("Integration peer requires an explicit HTTPS origin");
  }
  return url;
}

export function parseIntegrationConfig(env: NodeJS.ProcessEnv = process.env): IntegrationConfig {
  const prefix = "LIFEWOOD_DESERET_INTEGRATION_";
  const get = (name: string) => env[prefix + name] || "";
  for (const name of ["ENABLED", "ALLOW_LOOPBACK_HTTP"]) {
    if (get(name) && !["true", "false", "1", "0"].includes(get(name))) throw Error(`Invalid integration ${name.toLowerCase()}`);
  }
  const days = get("INTAKE_DUE_DAYS");
  if (days && (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 365)) throw Error("Invalid integration intake due days");
  const config: IntegrationConfig = {
    enabled: ["true", "1"].includes(get("ENABLED")),
    peerBaseUrl: get("PEER_BASE_URL"),
    allowLoopbackHttp: ["true", "1"].includes(get("ALLOW_LOOPBACK_HTTP")),
    incomingKeyId: get("INCOMING_KEY_ID"), incomingSecret: get("INCOMING_SECRET"),
    outgoingKeyId: get("OUTGOING_KEY_ID"), outgoingSecret: get("OUTGOING_SECRET"),
    clientId: get("CLIENT_ID"), intakeOwnerEmail: get("INTAKE_OWNER_EMAIL"), intakeDueDays: Number(days),
  };
  if (config.enabled) {
    integrationPeerOrigin(config.peerBaseUrl, config.allowLoopbackHttp);
    if (!days) throw Error("Integration requires explicit intake due days");
    if (!identity(config.incomingKeyId) || !identity(config.outgoingKeyId) || !validSecret(config.incomingSecret) || !validSecret(config.outgoingSecret)) throw Error("Integration requires dedicated service credentials");
    if (!identity(config.clientId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.intakeOwnerEmail) || config.intakeOwnerEmail.length > 254) throw Error("Integration requires a configured client and intake owner");
  }
  return config;
}

export function resolveIntegrationEndpoint(config: Pick<IntegrationConfig, "enabled" | "peerBaseUrl" | "allowLoopbackHttp">, path: string): URL {
  if (!config.enabled) throw Error("Integration is disabled");
  if (!/^\/api\/integrations\/(?:aigc\/events(?:\/receipt)?|deseret-book\/(?:events|handoffs))$/.test(path)) throw Error("Unsupported integration endpoint");
  return new URL(path, integrationPeerOrigin(config.peerBaseUrl, config.allowLoopbackHttp));
}

export function integrationBodyHash(body: Uint8Array | string): string {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (bytes.byteLength > MAX_INTEGRATION_BODY_BYTES) throw Error("Integration metadata exceeds the size limit");
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A non-2xx answer as a coded error: `REMOTE_<status>`, plus Deseret's own `code` (for example `request_reused`)
 * when the body states one in the expected form. `httpStatus` is used instead of `status` so existing job
 * error mapping (`status` 403 → ACCESS_DENIED) is unchanged.
 */
async function remoteFailure(response: Response) {
  let remoteCode: string | undefined;
  try {
    const body: unknown = await response.json();
    if (record(body) && typeof body.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(body.code)) remoteCode = body.code;
  } catch { /* An unreadable body states no code. */ }
  return Object.assign(Error("Integration delivery failed."), { code: `REMOTE_${response.status}`, httpStatus: response.status, ...(remoteCode ? { remoteCode } : {}) });
}

/** Accepts only Deseret's acknowledgement of exactly this event; anything else is a coded failure. */
export async function readDeliveryAcknowledgement(response: Response, eventId: string): Promise<void> {
  if (!response.ok) throw await remoteFailure(response);
  const acknowledgement: unknown = await response.json();
  if (!record(acknowledgement) || acknowledgement.accepted !== true || acknowledgement.eventId !== eventId)
    throw Object.assign(Error("Integration acknowledgement mismatch."), { code: "REMOTE_ACK_MISMATCH" });
}

export type ReceiptLookup = { eventId: string; projectId: string; bodySha256: string };
export const RECEIPT_LOOKUP_PATH = "/api/integrations/aigc/events/receipt";

/**
 * Signed lookup of Deseret's receipt for one AIGC event (contract of 2026-11-21): POST {eventId, projectId,
 * bodySha256} with the event id as request id. `projectId` is the Deseret project id of the original envelope;
 * `bodySha256` is the SHA-256 of the exact bytes originally sent.
 */
export function receiptLookupRequest(config: Pick<IntegrationConfig, "enabled" | "peerBaseUrl" | "allowLoopbackHttp" | "outgoingKeyId" | "outgoingSecret">, query: ReceiptLookup) {
  if (!identity(query.eventId) || !identity(query.projectId) || !digestPattern.test(query.bodySha256)) throw Error("Invalid receipt lookup");
  const url = resolveIntegrationEndpoint(config, RECEIPT_LOOKUP_PATH);
  const body = JSON.stringify({ eventId: query.eventId, projectId: query.projectId, bodySha256: query.bodySha256 });
  const headers: Record<string, string> = {
    ...signIntegrationRequest({ sender: "aigc", keyId: config.outgoingKeyId, secret: config.outgoingSecret, method: "POST", pathAndQuery: url.pathname + url.search, body, requestId: query.eventId }),
    "content-type": "application/json",
  };
  return { url, init: { method: "POST", headers, body, redirect: "error" as const } };
}

/**
 * true only for 200 {accepted:true, eventId, status:"received"}; 404 means no matching receipt (false). Any other
 * answer is a coded error: it says nothing about the receipt and is retried.
 */
export async function readReceiptConfirmation(response: Response, eventId: string): Promise<boolean> {
  if (response.status === 404) return false;
  if (response.status !== 200) throw await remoteFailure(response);
  try {
    const answer: unknown = await response.json();
    return record(answer) && answer.accepted === true && answer.eventId === eventId && answer.status === "received";
  } catch {
    return false;
  }
}

type SigningInput = {
  sender: IntegrationService; keyId: string; secret: string;
  method: string; pathAndQuery: string; body: Uint8Array | string;
  requestId: string; timestamp?: string;
};
function canonical(input: SigningInput, timestamp: string): string {
  const invalidPath = !input.pathAndQuery.startsWith("/") || input.pathAndQuery.startsWith("//") ||
    Array.from(input.pathAndQuery).some((character) => character.charCodeAt(0) <= 32 || character === "#");
  if (
    !["deseret", "aigc"].includes(input.sender) ||
    !identity(input.keyId) || !identity(input.requestId) || !validSecret(input.secret) ||
    !/^[A-Z]{1,12}$/.test(input.method) || invalidPath || !/^\d{1,12}$/.test(timestamp)
  ) throw Error("Invalid integration signature input");
  return [protocol, input.sender, input.keyId, timestamp, input.requestId, input.method, input.pathAndQuery, integrationBodyHash(input.body)].join("\n");
}

export function signIntegrationRequest(input: SigningInput): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", input.secret).update(canonical(input, timestamp), "utf8").digest("hex");
  return {
    "x-lw-service": input.sender, "x-lw-key-id": input.keyId,
    "x-lw-timestamp": timestamp, "x-lw-request-id": input.requestId,
    "x-lw-signature": signature,
  };
}

type HeaderValues = Headers | Record<string, string | string[] | undefined>;
function header(headers: HeaderValues, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) || undefined;
  const found = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  return found.length === 1 && typeof found[0][1] === "string" ? found[0][1] : undefined;
}
export function verifyIntegrationRequest(input: {
  headers: HeaderValues; expectedSender: IntegrationService; keyId: string; secret: string;
  method: string; pathAndQuery: string; body: Uint8Array | string; now?: number;
}): boolean {
  try {
    const sender = header(input.headers, "x-lw-service");
    const keyId = header(input.headers, "x-lw-key-id");
    const requestId = header(input.headers, "x-lw-request-id");
    const timestamp = header(input.headers, "x-lw-timestamp");
    const signature = header(input.headers, "x-lw-signature");
    if (sender !== input.expectedSender || keyId !== input.keyId || !requestId || !timestamp || !signature || !digestPattern.test(signature)) return false;
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || Math.abs(now - Number(timestamp)) > INTEGRATION_CLOCK_SKEW_SECONDS) return false;
    const expected = signIntegrationRequest({ ...input, sender: input.expectedSender, keyId: input.keyId, requestId, timestamp })["x-lw-signature"];
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function validateHandoffManifest(value: unknown): HandoffMaterial[] {
  if (!Array.isArray(value) || value.length > 256) throw Error("Invalid handoff file manifest");
  const seen = new Set<string>();
  return value.map((file) => {
    if (!record(file)) throw Error("Invalid handoff file manifest");
    const integrity = file.integrity;
    const validIntegrity = record(integrity) && ["sha256", "wasabi-sha256-parts-v1"].includes(String(integrity.algorithm)) &&
      typeof integrity.value === "string" && digestPattern.test(integrity.value);
    if ((file.sha256 !== undefined && (typeof file.sha256 !== "string" || !digestPattern.test(file.sha256))) ||
      (integrity !== undefined && !validIntegrity) ||
      (file.sha256 === undefined && !validIntegrity) ||
      (file.sha256 !== undefined && validIntegrity && (integrity.algorithm !== "sha256" || integrity.value !== file.sha256))) {
      throw Error("Invalid handoff integrity declaration");
    }
    if (
      !identity(file.id) ||
      !Number.isSafeInteger(file.version) || Number(file.version) < 1 ||
      !Number.isSafeInteger(file.size) || Number(file.size) < 1 ||
      !text(file.purpose, 100) || !identity(file.storageProfileId) ||
      !text(file.objectKey, 1024) || file.objectKey.startsWith("/") || file.objectKey.includes("\\") ||
      file.objectKey.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      Array.from(file.objectKey).some((character) => character.charCodeAt(0) <= 31) ||
      /^[A-Za-z]+:/.test(file.objectKey) ||
      !text(file.name, 255) || !text(file.mimeType, 120) || seen.has(`${file.id}:${file.version}`)
    ) throw Error("Invalid handoff file manifest");
    seen.add(`${file.id}:${file.version}`);
    return {
      id: file.id, version: Number(file.version), size: Number(file.size),
      ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
      ...(validIntegrity ? { integrity: { algorithm: integrity.algorithm as "sha256" | "wasabi-sha256-parts-v1", value: String(integrity.value) } } : {}),
      purpose: file.purpose, storageProfileId: file.storageProfileId,
      objectKey: file.objectKey, name: file.name, mimeType: file.mimeType,
    };
  });
}

export function validateIntegrationEnvelope(value: unknown): IntegrationEnvelope {
  if (
    !record(value) || value.schemaVersion !== 1 || !identity(value.eventId) || !identity(value.projectId) ||
    !text(value.sourceRevision, 120) || !text(value.type, 64) || !integrationEventTypes.some((type) => type === value.type) ||
    !text(value.occurredAt, 64) || !Number.isFinite(Date.parse(value.occurredAt)) || !record(value.payload)
  ) throw Error("Invalid integration event");
  let payload = value.payload;
  if (value.type === "project.handoff") {
    const { project, approval } = payload;
    if (
      !Number.isSafeInteger(payload.submissionVersion) || Number(payload.submissionVersion) < 1 ||
      !record(project) || !text(project.title, 255) || !Array.isArray(project.languageCodes) ||
      project.languageCodes.length < 1 || project.languageCodes.length > 20 ||
      project.languageCodes.some((code) => !text(code, 35) || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code)) ||
      !record(approval) || !identity(approval.id) || !identity(approval.actorId) ||
      !Number.isSafeInteger(approval.version) || Number(approval.version) < 1 ||
      !text(approval.decidedAt, 64) || !Number.isFinite(Date.parse(approval.decidedAt)) || !record(payload.brief)
    ) throw Error("Invalid approved brief handoff");
    payload = { ...payload, files: validateHandoffManifest(payload.files) };
  }
  return { schemaVersion: 1, eventId: value.eventId, type: value.type as IntegrationEnvelope["type"], projectId: value.projectId, sourceRevision: value.sourceRevision, occurredAt: value.occurredAt, payload };
}
