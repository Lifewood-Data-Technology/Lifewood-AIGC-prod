"use client";
import { useState, type ReactNode } from "react";
import DataList, { DataListTable } from "./DataList";
import { auditActionLabel, auditActor, auditSubject, auditSummary, auditModuleLabels, auditModuleLabel, auditLocationLabel, type AuditRecord } from "../lib/audit-display";
import { accessTime } from "./AccountAccessPanel";
import { LogDateHeader, LogDateRange, LogPagination, LogSelection, LogStatus, LogText, LogToolbar, logStatusLabel } from "./AdminLogControls";
import LogDetailDialog, { LogDetailFields } from "./LogDetailDialog";
import AdminLogDeletion from "./AdminLogDeletion";
import useLogRecords from "./useLogRecords";
const empty = { module: "", actor: "", query: "", ip: "", status: "", action: "", start: "", end: "" };
function validRow(value: unknown): value is AuditRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.id) && Number(record.id) > 0
    && ["action", "operation", "actor_email", "subject", "details", "created_at"].every(key => typeof record[key] === "string")
    && ["module", "actor_name", "actor_role", "subject_name", "subject_role", "ip_address", "status", "request_id", "error_code"].every(key => record[key] == null || typeof record[key] === "string")
    && (record.duration_ms == null || typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms) && record.duration_ms >= 0);
}
function AuditDetail({ row, locale, close, returnFocus }: { row: AuditRecord; locale: "zh" | "en"; close: () => void; returnFocus: HTMLElement | null }) {
  const zh = locale === "zh", missing = zh ? "未记录" : "Not recorded", summary = auditSummary(row, locale);
  let structured = false, changes: [string, string][] = [];
  try {
    const parsed: unknown = JSON.parse(row.details); structured = true;
    if (parsed && typeof parsed === "object") changes = Object.entries(parsed).map(([key, value]) => [Array.isArray(parsed) ? `[${key}]` : key, typeof value === "string" ? value : JSON.stringify(value, null, 2)]);
    if (!changes.length) changes = [[zh ? "内容" : "Content", typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)]];
  } catch { /* Keep historical free text intact when there is no structured payload. */ }
  const summaryIsRawJson = structured && summary.trim() === row.details.trim();
  const fields: [string, ReactNode][] = [[zh ? "日志编号" : "Log ID", String(row.id)], [zh ? "系统模块" : "Module", auditModuleLabel(row.module, locale)], [zh ? "操作类型" : "Operation", auditActionLabel(row.operation, locale)], [zh ? "操作人员" : "Actor", auditActor(row, locale)], [zh ? "操作人邮箱" : "Actor email", row.actor_email], [zh ? "操作对象" : "Subject", auditSubject(row, locale)], [zh ? "操作地址" : "IP address", row.ip_address], [zh ? "操作地点" : "Location", auditLocationLabel(row.ip_address, locale)], [zh ? "操作状态" : "Status", logStatusLabel(row.status, locale)], [zh ? "操作日期（上海）" : "Operation date (Shanghai)", accessTime(row.created_at, locale)], [zh ? "消耗时间" : "Duration", row.duration_ms == null ? missing : `${row.duration_ms} ms`], ...(!summaryIsRawJson ? [[zh ? "变更摘要" : "Changes", summary] as [string, ReactNode]] : [])];
  return <LogDetailDialog locale={locale} title={zh ? "操作日志详情" : "Operation log details"} close={close} returnFocus={returnFocus}>
    <LogDetailFields fields={fields} missing={missing} />
    {changes.length > 0 && <details className="log-structured-changes" open={summaryIsRawJson}><summary>{zh ? "完整变更记录" : "Complete change record"}</summary><LogDetailFields fields={changes.map(([key, value]) => [key, <span className="log-change-value" key={key}>{value}</span>])} missing={missing} /></details>}
    {!structured && row.details && summary !== row.details && <details className="log-structured-changes"><summary>{zh ? "原始记录" : "Original record"}</summary><p className="log-change-value">{row.details}</p></details>}
    {row.duration_ms != null && <p className="log-muted">{row.action === "session.signed_in" ? zh ? "耗时为服务端完成本次登录校验的时间，不包含后台日志写入。" : "Duration measures server sign-in verification, excluding background log persistence." : zh ? "耗时为服务端处理本次请求的时间，同一请求产生的多条日志共享该耗时。" : "Duration measures server processing for this request. Records from the same request share this duration."}</p>}
    {row.request_id && <p className="log-request-id">{zh ? "请求编号：" : "Request ID: "}{row.request_id}</p>}
  </LogDetailDialog>;
}
export default function AuditLogPanel({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh", missing = zh ? "未记录" : "Not recorded";
  const [draft, setDraft] = useState(empty), [filtersVisible, setFiltersVisible] = useState(true), [notice, setNotice] = useState("");
  const [deletion, setDeletion] = useState<{ ids?: string[]; filters: Record<string, string> } | null>(null);
  const log = useLogRecords<AuditRecord>({ endpoint: "/api/audit", locale, initialFilters: empty, validRow });
  const rows = log.data?.rows || [], total = log.data?.total || 0, unavailable = log.loading || !!log.error;
  const change = (key: keyof typeof empty, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  function apply() { if (draft.start && draft.end && draft.start > draft.end) { log.setError(zh ? "结束日期不能早于开始日期。" : "End date must not precede start date."); return; } setNotice(""); log.apply(draft); }
  return <section className="admin-log-page" aria-label={zh ? "操作日志" : "Operation logs"}>
    <DataList className="audit-data-list admin-log-workspace" ariaLabel={zh ? "操作记录" : "Audit records"} toolbar={filtersVisible && <form className="log-query-form" onSubmit={event => { event.preventDefault(); apply(); }}>
      <label><span>{zh ? "系统模块" : "Module"}</span><select value={draft.module} onChange={event => change("module", event.target.value)}><option value="">{zh ? "全部模块" : "All modules"}</option>{Object.keys(auditModuleLabels).map(module => <option key={module} value={module}>{auditModuleLabel(module, locale)}</option>)}</select></label>
      <label><span>{zh ? "操作人员" : "Actor"}</span><input maxLength={254} placeholder={zh ? "输入姓名或邮箱" : "Name or email"} value={draft.actor} onChange={event => change("actor", event.target.value)} /></label>
      <label><span>{zh ? "操作地址" : "IP address"}</span><input maxLength={45} placeholder={zh ? "输入操作地址" : "Enter IP address"} value={draft.ip} onChange={event => change("ip", event.target.value)} /></label>
      <label><span>{zh ? "操作类型" : "Operation"}</span><select value={draft.action} onChange={event => change("action", event.target.value)}><option value="">{zh ? "全部类型" : "All operations"}</option>{log.data?.actions?.map(action => <option key={action} value={action}>{auditActionLabel(action, locale)}</option>)}</select></label>
      <label><span>{zh ? "状态" : "Status"}</span><select value={draft.status} onChange={event => change("status", event.target.value)}><option value="">{zh ? "全部状态" : "All statuses"}</option>{["success", "failure", "unconfirmed", "unrecorded"].map(status => <option key={status} value={status}>{logStatusLabel(status, locale)}</option>)}</select></label>
      <label><span>{zh ? "关键字" : "Keyword"}</span><input maxLength={200} placeholder={zh ? "搜索对象或变更内容" : "Subject or change content"} value={draft.query} onChange={event => change("query", event.target.value)} /></label>
      <LogDateRange locale={locale} label={zh ? "操作时间" : "Operation date"} start={draft.start} end={draft.end} change={change} />
      <div className="log-query-actions"><button type="submit" className="primary-button" disabled={log.loading}>{zh ? "搜索" : "Search"}</button><button type="button" className="secondary-button" onClick={() => { setDraft(empty); setNotice(""); log.apply(empty); }}>{zh ? "重置" : "Reset"}</button></div>
    </form>} actions={<LogToolbar locale={locale} selected={log.selected.length} total={total} busy={log.loading} readOnly={!!log.error} exporting={log.exporting} filtersVisible={filtersVisible} toggleFilters={() => setFiltersVisible(value => !value)} refresh={log.refresh} remove={() => setDeletion({ ids: log.selected, filters: log.filters })} clear={() => setDeletion({ filters: log.filters })} exportCsv={() => void log.exportCsv()} />}
      pagination={<LogPagination locale={locale} page={log.current} pages={log.pages} pageSize={log.pageSize} total={total} selected={log.selected.length} busy={unavailable} setPage={log.changePage} setSize={log.changeSize} />}>
      {log.error && <p role="alert" className="log-error">{log.error}<button type="button" className="link-button" onClick={log.refresh}>{zh ? "重试" : "Retry"}</button></p>}
      {notice && <p role="status" className="log-notice">{notice}</p>}
      {log.loading && !!rows.length && <p role="status" className="log-muted log-loading">{zh ? "正在刷新，以下为上次读取的记录…" : "Refreshing. The previous records remain below…"}</p>}
      <DataListTable ariaLabel={zh ? "操作日志表格，可横向滚动" : "Operation logs, horizontally scrollable"}><table className="work-table admin-log-table audit-log-table" aria-busy={log.loading || log.detailLoading}><colgroup>{[40, 76, 92, 118, 98, 118, 86, 116, 156, 84, 72].map((width, index) => <col key={index} style={{ width }} />)}</colgroup><thead><tr>
        <th className="log-check-column" scope="col"><LogSelection label={zh ? "选择当前页全部记录" : "Select all records on this page"} checked={rows.length > 0 && log.selected.length === rows.length} mixed={log.selected.length > 0 && log.selected.length < rows.length} disabled={unavailable || !rows.length} change={log.toggleAll} /></th>
        {[zh ? "日志编号" : "Log ID", zh ? "系统模块" : "Module", zh ? "操作类型" : "Operation", zh ? "操作人员" : "Actor", zh ? "操作地址" : "IP address", zh ? "操作地点" : "Location", zh ? "操作状态" : "Status"].map(label => <th key={label} scope="col">{label}</th>)}
        <LogDateHeader locale={locale} label={zh ? "操作日期" : "Operation date"} sort={log.sort} change={log.changeSort} /><th scope="col">{zh ? "消耗时间" : "Duration"}</th><th scope="col">{zh ? "操作" : "Actions"}</th>
      </tr></thead><tbody>{rows.map(row => <tr key={row.id} aria-selected={log.selected.includes(String(row.id))}>
        <td className="log-check-column"><LogSelection label={zh ? `选择日志 ${row.id}` : `Select log ${row.id}`} checked={log.selected.includes(String(row.id))} disabled={unavailable} change={checked => log.toggleRow(String(row.id), checked)} /></td>
        <td><LogText>{String(row.id)}</LogText></td><td><LogText>{auditModuleLabel(row.module, locale)}</LogText></td><td><LogText>{auditActionLabel(row.operation, locale)}</LogText></td><td><LogText>{auditActor(row, locale)}</LogText></td><td><LogText>{row.ip_address || missing}</LogText></td><td>{auditLocationLabel(row.ip_address, locale)}</td><td><LogStatus status={row.status} locale={locale} /></td><td><LogText>{accessTime(row.created_at, locale)}</LogText></td><td>{row.duration_ms == null ? missing : `${row.duration_ms} ms`}</td><td><button type="button" className="link-button" disabled={log.detailLoading || unavailable} onClick={event => void log.openDetail(row, event.currentTarget)}>{zh ? "详情" : "Details"}</button></td>
      </tr>)}{!rows.length && <tr><td colSpan={11} className="log-empty">{log.loading ? zh ? "正在读取…" : "Loading…" : log.error ? zh ? "读取失败，请重试。" : "Loading failed. Retry." : zh ? "没有符合条件的操作记录。" : "No matching operation records."}</td></tr>}</tbody></table></DataListTable>
    </DataList>
    {log.detail && <AuditDetail row={log.detail} locale={locale} returnFocus={log.detailReturnFocus} close={() => log.setDetail(null)} />}
    <AdminLogDeletion kind="audit" locale={locale} request={deletion} close={() => setDeletion(null)} denied={() => { log.clearPrivateData(); log.setError(zh ? "当前无权管理日志，请重新验证账号权限。" : "You no longer have permission to manage logs."); }} completed={count => { setNotice(zh ? `已永久删除 ${count} 条日志，清理操作已另行记录。` : `${count} logs permanently deleted. The cleanup was recorded separately.`); log.refresh(); }} />
  </section>;
}
