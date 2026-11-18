import { zhipuErrorText } from "../lib/zhipu-errors";
import type { ZhipuErrorCode } from "../lib/zhipu-errors";

const API_ORIGIN = "https://open.bigmodel.cn";
export const DEFAULT_ZHIPU_MODEL = "glm-4.7-flash";
export const DEFAULT_ZHIPU_FALLBACK_MODEL = "glm-4-flash-250414";
export const ZHIPU_SOURCE_TEXT_BUDGET = 450_000;

type Fetcher = typeof fetch;
type Stage = "document-upload" | "document-processing" | "analysis";

export function resolveZhipuModels(primary?: string, fallback?: string) {
  const models = [
    String(primary ?? "").trim() || DEFAULT_ZHIPU_MODEL,
    String(fallback ?? "").trim() || DEFAULT_ZHIPU_FALLBACK_MODEL,
  ];
  return [...new Set(models.filter(Boolean))];
}

export class ZhipuError extends Error {
  readonly code: ZhipuErrorCode;
  readonly upstreamStatus: number | undefined;
  constructor(code: ZhipuErrorCode, diagnostic = "", status?: number) {
    super(`[ZHIPU_${code}] ${zhipuErrorText(code)}${diagnostic ? `\n${diagnostic}` : ""}`);
    this.name = "ZhipuError";
    this.code = code;
    this.upstreamStatus = status;
  }
}

export function redactZhipuDiagnostic(value: unknown, apiKey: string) {
  let text = typeof value === "string" ? value : "";
  if (apiKey) text = text.split(apiKey).join("[REDACTED]");
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b[0-9a-f]{20,}\.[A-Za-z0-9_-]{10,}\b/gi, "[REDACTED]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:key|api_key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 450);
}

export async function zhipuRequest(
  apiKey: string,
  url: string,
  init: RequestInit,
  stage: Stage,
  fetcher: Fetcher = fetch,
  timeoutMs = 90_000,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal, redirect: "manual" });
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && /TimeoutError|AbortError/.test(error.name));
    const invalidOptions = error instanceof TypeError && /invalid redirect|invalid.*header|header.*invalid|ByteString|RequestInit/i.test(error.message);
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "Transport rejected the request";
    throw new ZhipuError(timedOut ? "TIMEOUT" : invalidOptions ? "CONFIG" : "NETWORK", `${stage} · ${redactZhipuDiagnostic(detail, apiKey)}`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ZhipuError("PROTOCOL", `${stage} · HTTP ${response.status} · unexpected redirect refused`, response.status);
  }
  if (response.ok) return response;
  const body = await response.json().catch(() => ({})) as {
    error?: { code?: string | number; message?: string };
    code?: string | number;
    message?: string;
  };
  const providerCode = String(body?.error?.code ?? body?.code ?? "");
  const providerMessage = String(body?.error?.message ?? body?.message ?? "");
  const raw = `${providerCode} ${providerMessage}`;
  const code: ZhipuErrorCode = /invalid.*(?:api|key|token)|authentication|unauthorized|1000|1001|1002|1003|1004/i.test(raw) || response.status === 401
    ? "AUTH"
    : response.status === 403 ? "PERMISSION"
      : response.status === 429 || /访问量过大|rate|quota|1305/i.test(raw) ? "QUOTA"
        : response.status === 408 || response.status === 504 ? "TIMEOUT"
          : response.status >= 500 ? "UNAVAILABLE"
            : response.status === 404 && stage === "analysis" ? "MODEL" : "REQUEST";
  const safeCode = providerCode.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const diagnostic = `${stage} · HTTP ${response.status}${safeCode ? ` · ${safeCode}` : ""}${providerMessage ? ` · ${redactZhipuDiagnostic(providerMessage, apiKey)}` : ""}`;
  throw new ZhipuError(code, diagnostic, response.status);
}

export async function readZhipuJson(response: Response, stage: Stage): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    const timedOut = error instanceof Error && /TimeoutError|AbortError/.test(error.name);
    throw new ZhipuError(timedOut ? "TIMEOUT" : stage === "analysis" ? "OUTPUT" : "PROTOCOL", `${stage} · invalid or interrupted JSON response`);
  }
}

const localTextMimeTypes = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
const supportedFileTypes = new Set(["PDF", "DOCX", "DOC", "XLS", "XLSX", "PPT", "PPTX", "PNG", "JPG", "JPEG", "CSV", "TXT", "MD"]);

function fileType(name: string, mimeType: string) {
  const extension = name.split(".").pop()?.toUpperCase() ?? "";
  if (supportedFileTypes.has(extension)) return extension;
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) {
    const imageType = mimeType.split("/")[1].toUpperCase();
    if (supportedFileTypes.has(imageType)) return imageType;
  }
  throw new ZhipuError("REQUEST", `document-upload · unsupported file type: ${extension || "unknown"}`);
}

export async function extractZhipuDocumentText(
  apiKey: string,
  document: { name: string; mimeType: string; bytes: ArrayBuffer },
  fetcher: Fetcher = fetch,
) {
  if (localTextMimeTypes.has(document.mimeType))
    return new TextDecoder().decode(document.bytes);

  const form = new FormData();
  form.append("file", new Blob([document.bytes], { type: document.mimeType }), document.name);
  form.append("tool_type", "lite");
  form.append("file_type", fileType(document.name, document.mimeType));
  const created = await zhipuRequest(apiKey, `${API_ORIGIN}/api/paas/v4/files/parser/create`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  }, "document-upload", fetcher, 60_000);
  const createBody = await readZhipuJson(created, "document-upload") as {
    success?: boolean;
    task_id?: string;
    message?: string;
    msg?: string;
    data?: { task_id?: string; taskId?: string; message?: string };
  };
  // The live parser currently omits `success` even for HTTP 200 responses,
  // while some SDK/API versions wrap the task id in `data`. Accept either
  // documented shape, but still reject an explicit failure or missing id.
  const taskId = String(createBody?.task_id ?? createBody?.data?.task_id ?? createBody?.data?.taskId ?? "");
  if (createBody?.success === false || !/^[A-Za-z0-9_-]+$/.test(taskId))
    throw new ZhipuError("PROTOCOL", `document-upload · ${redactZhipuDiagnostic(createBody?.data?.message || createBody?.message || createBody?.msg || "missing task id", apiKey)}`);

  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1_000));
    const result = await zhipuRequest(apiKey, `${API_ORIGIN}/api/paas/v4/files/parser/result/${encodeURIComponent(taskId)}/text`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }, "document-processing", fetcher, 20_000);
    const body = await readZhipuJson(result, "document-processing") as {
      success?: boolean;
      status?: string;
      content?: string;
      message?: string;
      msg?: string;
      data?: { status?: string; content?: string; message?: string };
    };
    const resultBody = body?.data ?? body;
    const status = String(resultBody?.status ?? "").toLowerCase();
    if (status === "succeeded") {
      const content = String(resultBody?.content ?? "").trim();
      if (!content) throw new ZhipuError("OUTPUT", "document-processing · empty parsed text");
      return content;
    }
    if (status && status !== "processing" && status !== "pending")
      throw new ZhipuError("PROCESSING", `document-processing · ${redactZhipuDiagnostic(resultBody?.message || body?.message || body?.msg || status, apiKey)}`);
  }
  throw new ZhipuError("PROCESSING", "document-processing · timed out waiting for parser");
}

export function zhipuAnalysisRequestBody(model: string, prompt: string, schema: Record<string, unknown>) {
  return {
    model,
    messages: [
      {
        role: "system",
        content: `Return exactly one JSON object matching this schema. Do not wrap it in Markdown. Do not add fields.\n${JSON.stringify(schema)}`,
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    stream: false,
    max_tokens: 16_384,
  };
}

export async function runZhipuAnalysis(
  apiKey: string,
  models: string[],
  prompt: string,
  schema: Record<string, unknown>,
  fetcher: Fetcher = fetch,
) {
  let lastError: unknown;
  for (const model of models) {
    try {
      const response = await zhipuRequest(apiKey, `${API_ORIGIN}/api/paas/v4/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(zhipuAnalysisRequestBody(model, prompt, schema)),
      }, "analysis", fetcher);
      return { model, body: await readZhipuJson(response, "analysis") };
    } catch (error) {
      lastError = error;
      if (!(error instanceof ZhipuError) || !["QUOTA", "TIMEOUT", "UNAVAILABLE"].includes(error.code)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new ZhipuError("UNAVAILABLE", "analysis · all configured models failed");
}
