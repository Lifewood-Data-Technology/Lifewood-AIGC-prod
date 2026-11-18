import type { AccessEvent } from './account-access';
import { logCsv, parseLogReadControls, validLogDate, validateLogParameters, type LogReadControls } from './log-query-controls';
export type LoginLogStatus = 'success' | 'failure' | 'blocked' | 'signed_out';
export type LoginLogRow = AccessEvent & { account_email: string; account_name: string | null; status: LoginLogStatus | null };
export type LoginLogPage = { rows: LoginLogRow[]; total: number; page: number; pageSize: number };
export const loginLogEvents = ['signed_in', 'resumed', 'failed', 'locked', 'blocked', 'signed_out'] as const;
export type LoginLogQuery = LogReadControls & { query: string; email: string; ip: string; event: string; status: string; start: string; end: string };
export function parseLoginLogQuery(params: URLSearchParams): LoginLogQuery {
  validateLogParameters(params, ['query', 'email', 'ip', 'event', 'status', 'start', 'end', 'page', 'pageSize', 'sort', 'format', 'export', 'ids', 'detailId']);
  const controls = parseLogReadControls(params);
  const query = (params.get('query') || '').trim(), email = (params.get('email') || '').trim(), ip = (params.get('ip') || '').trim(), event = params.get('event') || '', status = params.get('status') || '', start = params.get('start') || '', end = params.get('end') || '';
  if (query.length > 254 || email.length > 254 || ip.length > 45 || (event && !loginLogEvents.some(e => e === event)) || !['', 'success', 'failure', 'blocked', 'signed_out'].includes(status) || !validLogDate(start) || !validLogDate(end) || (start && end && start > end)) throw new Error('Invalid login-log filters.');
  return { ...controls, query, email, ip, event, status, start, end };
}
export function loginLogStatus(event: string): LoginLogStatus | null {
  if (event === 'signed_in' || event === 'resumed') return 'success';
  if (event === 'failed' || event === 'locked') return 'failure';
  if (event === 'blocked' || event === 'signed_out') return event;
  return null;
}
export function loginLogStatusLabel(status: LoginLogStatus | null | undefined, locale: 'zh' | 'en'): string {
  const labels: Record<string, [string, string]> = { success: ['成功', 'Success'], failure: ['失败', 'Failed'], blocked: ['已阻止', 'Blocked'], signed_out: ['已退出', 'Signed out'] };
  return (labels[status || ''] || ['未记录', 'Not recorded'])[locale === 'zh' ? 0 : 1];
}
/** Export only the fields already available to the authorized log query. */
export function loginLogCsv(rows: LoginLogRow[]): string {
  return logCsv(['id', 'account_email', 'account_name', 'ip_address', 'browser', 'os', 'status', 'event', 'occurred_at'], rows.map(row => [row.id, row.account_email, row.account_name, row.ip_address, row.browser, row.os, row.status, row.event, row.occurred_at]));
}
