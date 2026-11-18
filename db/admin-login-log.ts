import type { Database } from './database';
import { parseLoginLogQuery, type LoginLogPage, type LoginLogQuery, type LoginLogRow } from '../lib/admin-login-log';
import { LOG_SELECTION_LIMIT, validateLogIds } from '../lib/log-query-controls';
import { PublicError } from '../lib/security-controls';
const status = `CASE WHEN h.event IN ('signed_in','resumed') THEN 'success' WHEN h.event IN ('failed','locked') THEN 'failure' WHEN h.event = 'blocked' THEN 'blocked' WHEN h.event = 'signed_out' THEN 'signed_out' ELSE NULL END`;
const joins = 'FROM account_login_history h LEFT JOIN accounts a ON a.email = h.account_email';
const columns = `h.id,h.account_email,a.name account_name,h.occurred_at,h.event,h.ip_address,h.browser,h.os,${status} status`;
function loginWhere(query: LoginLogQuery, now: number, ids?: readonly string[]) {
  const predicates = ['h.occurred_at >= ?'], values: unknown[] = [new Date(now - 90 * 86_400_000).toISOString()];
  if (query.email) { predicates.push('INSTR(LOWER(h.account_email), ?) > 0'); values.push(query.email.toLowerCase()); }
  if (query.query) { predicates.push('(INSTR(LOWER(h.account_email), ?) > 0 OR INSTR(LOWER(a.name), ?) > 0)'); values.push(query.query.toLowerCase(), query.query.toLowerCase()); }
  if (query.ip) { predicates.push('h.ip_address = ?'); values.push(query.ip); }
  if (query.event) { predicates.push('h.event = ?'); values.push(query.event); }
  if (query.status) { predicates.push(`(${status}) = ?`); values.push(query.status); }
  if (query.start) { predicates.push('h.occurred_at >= ?'); values.push(new Date(query.start + 'T00:00:00+08:00').toISOString()); }
  if (query.end) { predicates.push('h.occurred_at < ?'); values.push(new Date(Date.parse(query.end + 'T00:00:00+08:00') + 86_400_000).toISOString()); }
  if (ids) { predicates.push(`h.id IN (${ids.map(() => '?').join(',')})`); values.push(...ids); }
  return { where: predicates.join(' AND '), values };
}
async function rowsFor(db: Database, query: LoginLogQuery, now: number, ids: readonly string[] | undefined, limit: number, offset = 0) {
  const { where, values } = loginWhere(query, now, ids), order = query.sort === 'asc' ? 'ASC' : 'DESC';
  return (await db.prepare(`SELECT ${columns} ${joins} WHERE ${where} ORDER BY h.occurred_at ${order},h.id ${order} LIMIT ? OFFSET ?`).bind(...values, limit, offset).all<LoginLogRow>()).results;
}
/** Caller must authorize the administrator. Mirrors the existing 90-day history boundary. */
export async function readLoginLog(db: Database, query: LoginLogQuery, now = Date.now(), exportAll = false): Promise<LoginLogPage> {
  const { where, values } = loginWhere(query, now), count = await db.prepare(`SELECT COUNT(*) AS total ${joins} WHERE ${where}`).bind(...values).first<{ total: number }>();
  const total = Number(count?.total || 0), page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)));
  if (exportAll && total > LOG_SELECTION_LIMIT) throw new Error('EXPORT_TOO_LARGE');
  const rows = await rowsFor(db, query, now, undefined, exportAll ? LOG_SELECTION_LIMIT + 1 : query.pageSize, exportAll ? 0 : (page - 1) * query.pageSize);
  if (exportAll && rows.length > LOG_SELECTION_LIMIT) throw new Error('EXPORT_TOO_LARGE');
  return { rows, total, page, pageSize: query.pageSize };
}
/** Caller authorizes accounts.manage. Selection cannot escape filters or the 90-day boundary. */
export async function readLoginLogSelection(db: Database, params: URLSearchParams, ids?: string[], now = Date.now()): Promise<LoginLogRow[]> {
  let query: LoginLogQuery, selected: string[] | undefined;
  try { query = parseLoginLogQuery(params); selected = ids === undefined ? query.ids : validateLogIds(ids); } catch { throw new PublicError('Invalid login-log filters or selection.', 400); }
  const { where, values } = loginWhere(query, now, selected), count = await db.prepare(`SELECT COUNT(*) AS total ${joins} WHERE ${where}`).bind(...values).first<{ total: number }>();
  if (Number(count?.total || 0) > LOG_SELECTION_LIMIT) throw new PublicError('Narrow filters to at most 10,000 records.', 400, 'EXPORT_TOO_LARGE');
  const rows = await rowsFor(db, query, now, selected, LOG_SELECTION_LIMIT + 1);
  if (rows.length > LOG_SELECTION_LIMIT) throw new PublicError('Narrow filters to at most 10,000 records.', 400, 'EXPORT_TOO_LARGE');
  if (selected && rows.length !== selected.length) throw new PublicError('Selected logs changed or no longer match these filters. Refresh and select again.', 409, 'LOG_SELECTION_CHANGED');
  return rows;
}
export async function readLoginLogDetail(db: Database, params: URLSearchParams, now = Date.now()): Promise<LoginLogRow> {
  let query: LoginLogQuery;
  try { query = parseLoginLogQuery(params); } catch { throw new PublicError('Invalid login-log filters.', 400); }
  if (!query.detailId) throw new PublicError('A log identifier is required.', 400);
  const [row] = await rowsFor(db, parseLoginLogQuery(new URLSearchParams()), now, [query.detailId], 1);
  if (!row) throw new PublicError('This log no longer exists or is outside the available history.', 404, 'LOG_NOT_FOUND');
  return row;
}
