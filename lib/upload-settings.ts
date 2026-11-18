import { MAX_ACCOUNT_UPLOAD_CONCURRENCY } from "./upload-workers.ts";

/** Server-only capacity settings. Defaults remain conservative; higher capacity requires explicit configuration. */
export function readUploadSettings(values: NodeJS.ProcessEnv = process.env) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw Error(`Invalid ${key}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${key}`);
    return value;
  };
  const siteConcurrency = integer("UPLOAD_SITE_CONCURRENCY", 2, 1, 64);
  const accountConcurrency = integer("UPLOAD_ACCOUNT_CONCURRENCY", 2, 1, MAX_ACCOUNT_UPLOAD_CONCURRENCY);
  const storageTimeoutMs = integer("UPLOAD_STORAGE_TIMEOUT_MS", 120_000, 30_000, 600_000);
  return { siteConcurrency, accountConcurrency, storageTimeoutMs,
    connectionTimeoutMs: 10_000, socketTimeoutMs: 30_000,
    clientConcurrency: Math.min(siteConcurrency, accountConcurrency),
    requestTimeoutMs: storageTimeoutMs + 120_000 };
}
