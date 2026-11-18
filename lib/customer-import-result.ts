/** An HTTP success alone cannot confirm a potentially committed import. */
export function isConfirmedCustomerImport(value: unknown, expectedRows?: readonly number[]): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (body.ok !== true || body.error || ![body.created, body.skipped, body.failed].every(count => Number.isSafeInteger(count) && Number(count) >= 0) || !Array.isArray(body.results)) return false;
  if (body.results.length !== Number(body.created) + Number(body.skipped) + Number(body.failed)) return false;
  const rows = new Set<number>();
  const counts = { created: 0, skipped: 0, error: 0 };
  for (const item of body.results) {
    if (!item || !Number.isSafeInteger(item.row) || item.row < 1 || rows.has(item.row) || !Object.hasOwn(counts, item.status)) return false;
    rows.add(item.row); counts[item.status as keyof typeof counts]++;
  }
  if (expectedRows && (expectedRows.length !== rows.size || new Set(expectedRows).size !== rows.size || expectedRows.some(row => !rows.has(row)))) return false;
  return counts.created === body.created && counts.skipped === body.skipped && counts.error === body.failed;
}
