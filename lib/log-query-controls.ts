/** Client-safe validation shared by the two administrator log endpoints. */
export type LogReadControls = { page: number; pageSize: number; sort: 'asc' | 'desc'; csv: boolean; ids?: string[]; detailId?: string };
export const LOG_SELECTION_LIMIT = 10_000;

export function validateLogParameters(params: URLSearchParams, allowed: readonly string[]) {
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw new Error('Invalid log filters.');
}

export function validLogDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function validateLogIds(ids: readonly string[], numeric = false): string[] {
  if (!ids.length || ids.length > LOG_SELECTION_LIMIT || ids.some(id => numeric ? !/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id)) : !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('Invalid log selection.');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate log selection.');
  return [...ids];
}

export function parseLogReadControls(params: URLSearchParams, numericIds = false): LogReadControls {
  const integer = (key: string, fallback: number) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^[1-9]\d{0,5}$/.test(value)) throw new Error('Invalid log pagination.');
    return Number(value);
  };
  const page = integer('page', 1), pageSize = integer('pageSize', 10), sort = params.get('sort') || 'desc';
  if (page > 100_000 || ![10, 20, 50, 100].includes(pageSize) || !['asc', 'desc'].includes(sort)) throw new Error('Invalid log pagination.');
  const format = params.get('format'), legacyExport = params.get('export');
  if ((format !== null && format !== 'csv') || (legacyExport !== null && legacyExport !== 'csv') || (format !== null && legacyExport !== null)) throw new Error('Invalid log format.');
  const csv = format === 'csv' || legacyExport === 'csv';
  const rawIds = params.get('ids'), rawDetail = params.get('detailId');
  if (rawIds !== null && (!csv || rawDetail !== null)) throw new Error('Invalid log selection.');
  if (rawDetail !== null && csv) throw new Error('Invalid log detail request.');
  const ids = rawIds === null ? undefined : validateLogIds(rawIds.split(','), numericIds);
  const detailId = rawDetail === null ? undefined : validateLogIds([rawDetail], numericIds)[0];
  return { page, pageSize, sort: sort as 'asc' | 'desc', csv, ids, detailId };
}

export function logCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
