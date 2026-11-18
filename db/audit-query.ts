import type { Database } from './database';
import { auditActionOptions, auditModuleLabels, auditModulePrefixes, type AuditRecord } from '../lib/audit-display';
import { LOG_SELECTION_LIMIT, parseLogReadControls, validLogDate, validateLogIds, validateLogParameters, type LogReadControls } from '../lib/log-query-controls';
import { PublicError } from '../lib/security-controls';

// The selector, filter, exports and details all classify the same historical operations.
const operation = `CASE WHEN l.action = 'account.updated' AND INSTR(l.details, ' · permissions ') > 0 THEN 'account.permissions_updated' WHEN l.action = 'account.updated' AND INSTR(l.details, ' · password reset') > 0 THEN 'account.password_reset' ELSE l.action END`;
const moduleExpression = `CASE ${Object.entries(auditModulePrefixes).map(([module, prefixes]) => `WHEN ${prefixes.map(prefix => `SUBSTR(l.action, 1, ${prefix.length}) = '${prefix}'`).join(' OR ')} THEN '${module}'`).join(' ')} ELSE 'other' END`;
const joins = `FROM audit_logs l LEFT JOIN accounts actor ON actor.email = l.actor_email LEFT JOIN accounts subject_account ON subject_account.email = l.subject LEFT JOIN audit_request_metadata m ON m.request_id = l.request_id`;
const columns = `l.id, l.action, l.actor_email, l.subject, l.details, l.created_at, actor.name actor_name, actor.access_group actor_role, subject_account.name subject_name, subject_account.access_group subject_role, ${operation} operation, ${moduleExpression} module, m.ip_address, m.outcome status, m.duration_ms, l.request_id, m.error_code`;
const allowed = ['page', 'pageSize', 'query', 'action', 'date', 'start', 'end', 'module', 'actor', 'ip', 'status', 'sort', 'format', 'ids', 'detailId'];
export type AuditQuery = LogReadControls & { query: string; action: string; start: string; end: string; module: string; actor: string; ip: string; status: string };

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  try {
    validateLogParameters(params, allowed);
    const controls = parseLogReadControls(params, true);
    const query = (params.get('query') || '').trim(), action = params.get('action') || '', date = params.get('date') || '';
    const start = params.get('start') || date, end = params.get('end') || date;
    const moduleFilter = params.get('module') || '', actor = (params.get('actor') || '').trim(), ip = (params.get('ip') || '').trim(), status = params.get('status') || '';
    if (query.length > 200 || action.length > 100 || actor.length > 254 || ip.length > 45 || !validLogDate(date) || !validLogDate(start) || !validLogDate(end) || (date && (params.has('start') || params.has('end'))) || (start && end && start > end) || (moduleFilter && !Object.hasOwn(auditModuleLabels, moduleFilter)) || !['', 'success', 'failure', 'unconfirmed', 'unrecorded'].includes(status)) throw new Error('Invalid audit filter.');
    return { ...controls, query, action, start, end, module: moduleFilter, actor, ip, status };
  } catch { throw new PublicError('Invalid audit filter.', 400); }
}

function auditWhere(query: AuditQuery, ids?: readonly string[]) {
  const clauses: string[] = [], values: unknown[] = [];
  const term = (value: string) => `%${value.replace(/[!%_]/g, '!$&')}%`;
  if (query.query) { clauses.push(`(l.actor_email LIKE ? ESCAPE '!' OR actor.name LIKE ? ESCAPE '!' OR l.subject LIKE ? ESCAPE '!' OR subject_account.name LIKE ? ESCAPE '!' OR l.details LIKE ? ESCAPE '!')`); values.push(...Array(5).fill(term(query.query))); }
  if (query.actor) { clauses.push(`(l.actor_email LIKE ? ESCAPE '!' OR actor.name LIKE ? ESCAPE '!')`); values.push(term(query.actor), term(query.actor)); }
  if (query.action) { clauses.push(`(${operation}) = ?`); values.push(query.action); }
  if (query.module) { clauses.push(`(${moduleExpression}) = ?`); values.push(query.module); }
  if (query.ip) { clauses.push('m.ip_address = ?'); values.push(query.ip); }
  if (query.status === 'unrecorded') clauses.push('m.outcome IS NULL');
  else if (query.status) { clauses.push('m.outcome = ?'); values.push(query.status); }
  if (query.start) { clauses.push('l.created_at >= ?'); values.push(new Date(`${query.start}T00:00:00+08:00`).toISOString()); }
  if (query.end) { clauses.push('l.created_at < ?'); values.push(new Date(Date.parse(`${query.end}T00:00:00+08:00`) + 86_400_000).toISOString()); }
  if (ids) { clauses.push(`l.id IN (${ids.map(() => '?').join(',')})`); values.push(...ids.map(Number)); }
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', values };
}

async function readRows(db: Database, query: AuditQuery, ids: readonly string[] | undefined, limit: number, offset = 0) {
  const { where, values } = auditWhere(query, ids), order = query.sort === 'asc' ? 'ASC' : 'DESC';
  return (await db.prepare(`SELECT ${columns} ${joins}${where} ORDER BY l.created_at ${order}, l.id ${order} LIMIT ? OFFSET ?`).bind(...values, limit, offset).all<AuditRecord>()).results;
}

export async function readAuditPage(db: Database, params: URLSearchParams) {
  const query = parseAuditQuery(params), { where, values } = auditWhere(query);
  const count = await db.prepare(`SELECT COUNT(*) total ${joins}${where}`).bind(...values).first<{ total: number }>();
  const total = Number(count?.total || 0), page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)));
  const rows = await readRows(db, query, undefined, query.pageSize, (page - 1) * query.pageSize);
  const types = await db.prepare(`SELECT DISTINCT ${operation} operation FROM audit_logs l ORDER BY operation`).all<{ operation: string }>();
  return { rows, total, page, pageSize: query.pageSize, actions: auditActionOptions(types.results.map(item => item.operation)), modules: Object.keys(auditModuleLabels) };
}

/** Caller authorizes system.manage. Used by CSV and immutable deletion previews. */
export async function readAuditSelection(db: Database, params: URLSearchParams, ids?: string[]): Promise<AuditRecord[]> {
  const query = parseAuditQuery(params);
  let selected: string[] | undefined;
  try { selected = ids === undefined ? query.ids : validateLogIds(ids, true); } catch { throw new PublicError('Invalid audit selection.', 400); }
  const { where, values } = auditWhere(query, selected);
  const count = await db.prepare(`SELECT COUNT(*) total ${joins}${where}`).bind(...values).first<{ total: number }>();
  if (Number(count?.total || 0) > LOG_SELECTION_LIMIT) throw new PublicError('Narrow filters to at most 10,000 records.', 400, 'EXPORT_TOO_LARGE');
  const rows = await readRows(db, query, selected, LOG_SELECTION_LIMIT + 1);
  if (rows.length > LOG_SELECTION_LIMIT) throw new PublicError('Narrow filters to at most 10,000 records.', 400, 'EXPORT_TOO_LARGE');
  if (selected && rows.length !== selected.length) throw new PublicError('Selected logs changed or no longer match these filters. Refresh and select again.', 409, 'LOG_SELECTION_CHANGED');
  return rows;
}

/** Detail intentionally ignores list filters but preserves the same administrator boundary. */
export async function readAuditDetail(db: Database, params: URLSearchParams): Promise<AuditRecord> {
  const query = parseAuditQuery(params);
  if (!query.detailId) throw new PublicError('A log identifier is required.', 400);
  const detailQuery = parseAuditQuery(new URLSearchParams());
  const [row] = await readRows(db, detailQuery, [query.detailId], 1);
  if (!row) throw new PublicError('This log no longer exists.', 404, 'LOG_NOT_FOUND');
  return row;
}
