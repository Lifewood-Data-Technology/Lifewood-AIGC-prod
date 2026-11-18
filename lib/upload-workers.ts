export const MAX_ACCOUNT_UPLOAD_CONCURRENCY = 8;

/** Fixed workers, rather than one promise per file. Each worker claims live work. */
export async function runUploadWorkers<T>(concurrency: number, next: () => T | undefined, work: (item: T) => Promise<void>) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_ACCOUNT_UPLOAD_CONCURRENCY) throw Error("Invalid upload concurrency");
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) { const item = next(); if (item === undefined) return; await work(item); }
  }));
}
