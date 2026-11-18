"use client";
import { useState } from "react";
import DataList, { DataListTable } from "./DataList";
import { loginEventLabels } from "../lib/account-access";
import { loginLogEvents, loginLogStatus, type LoginLogRow } from "../lib/admin-login-log";
import AdminLoginLogDetail from "./AdminLoginLogDetail";
import { accessTime } from "./AccountAccessPanel";
import { LogDateHeader, LogDateRange, LogPagination, LogSelection, LogStatus, LogText, LogToolbar, logStatusLabel } from "./AdminLogControls";
import AdminLogDeletion from "./AdminLogDeletion";
import useLogRecords from "./useLogRecords";
const empty = { query: "", ip: "", event: "", status: "", start: "", end: "" };
function validRow(value: unknown): value is LoginLogRow {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["id", "account_email", "event", "occurred_at"].every(key => typeof record[key] === "string")
    && ["account_name", "ip_address", "browser", "os", "status"].every(key => record[key] == null || typeof record[key] === "string")
    && loginLogEvents.some(event => event === record.event);
}
export default function AdminLoginLog({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh", missing = zh ? "未记录" : "Not recorded";
  const [draft, setDraft] = useState(empty), [filtersVisible, setFiltersVisible] = useState(true), [notice, setNotice] = useState("");
  const [deletion, setDeletion] = useState<{ ids?: string[]; filters: Record<string, string> } | null>(null);
  const log = useLogRecords<LoginLogRow>({ endpoint: "/api/admin-login-log", locale, initialFilters: empty, validRow });
  const rows = log.data?.rows || [], total = log.data?.total || 0, unavailable = log.loading || !!log.error;
  const change = (key: keyof typeof empty, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  function apply() { if (draft.start && draft.end && draft.start > draft.end) { log.setError(zh ? "结束日期不能早于开始日期。" : "End date must not precede start date."); return; } setNotice(""); log.apply(draft); }
  return <section className="admin-login-log admin-log-page" aria-label={zh ? "登录日志" : "Login logs"}>
    <DataList className="admin-log-workspace" ariaLabel={zh ? "登录记录" : "Login records"} toolbar={filtersVisible && <form className="log-query-form" onSubmit={event => { event.preventDefault(); apply(); }}>
      <label><span>{zh ? "用户名称" : "User name"}</span><input maxLength={254} placeholder={zh ? "输入姓名或邮箱" : "Name or email"} value={draft.query} onChange={event => change("query", event.target.value)} /></label>
      <label><span>{zh ? "登录地址" : "IP address"}</span><input maxLength={45} placeholder={zh ? "输入登录地址" : "Enter IP address"} value={draft.ip} onChange={event => change("ip", event.target.value)} /></label>
      <label><span>{zh ? "状态" : "Status"}</span><select value={draft.status} onChange={event => change("status", event.target.value)}><option value="">{zh ? "全部状态" : "All statuses"}</option>{["success", "failure", "blocked", "signed_out"].map(status => <option key={status} value={status}>{logStatusLabel(status, locale)}</option>)}</select></label>
      <label><span>{zh ? "登录事件" : "Event"}</span><select value={draft.event} onChange={event => change("event", event.target.value)}><option value="">{zh ? "全部事件" : "All events"}</option>{loginLogEvents.map(event => <option key={event} value={event}>{loginEventLabels[event][zh ? 0 : 1]}</option>)}</select></label>
      <LogDateRange locale={locale} label={zh ? "登录时间" : "Login date"} start={draft.start} end={draft.end} change={change} />
      <div className="log-query-actions"><button type="submit" className="primary-button" disabled={log.loading}>{zh ? "搜索" : "Search"}</button><button type="button" className="secondary-button" onClick={() => { setDraft(empty); setNotice(""); log.apply(empty); }}>{zh ? "重置" : "Reset"}</button></div>
    </form>} actions={<LogToolbar locale={locale} selected={log.selected.length} total={total} busy={log.loading} readOnly={!!log.error} exporting={log.exporting} filtersVisible={filtersVisible} toggleFilters={() => setFiltersVisible(value => !value)} refresh={log.refresh} remove={() => setDeletion({ ids: log.selected, filters: log.filters })} clear={() => setDeletion({ filters: log.filters })} exportCsv={() => void log.exportCsv()} />}
      pagination={<><p className="log-retention-note">{zh ? "查询最近 90 天内、每个账号保留的最近 100 条记录。" : "Showing retained records from the last 90 days, up to 100 per account."}</p><LogPagination locale={locale} page={log.current} pages={log.pages} pageSize={log.pageSize} total={total} selected={log.selected.length} busy={unavailable} setPage={log.changePage} setSize={log.changeSize} /></>}>
      {log.error && <p role="alert" className="log-error">{log.error}<button type="button" className="link-button" onClick={log.refresh}>{zh ? "重试" : "Retry"}</button></p>}
      {notice && <p role="status" className="log-notice">{notice}</p>}
      {log.loading && !!rows.length && <p role="status" className="log-muted log-loading">{zh ? "正在刷新，以下为上次读取的记录…" : "Refreshing. The previous records remain below…"}</p>}
      <DataListTable ariaLabel={zh ? "登录日志表格，可横向滚动" : "Login logs, horizontally scrollable"}><table className="work-table admin-log-table login-log-table" aria-busy={log.loading || log.detailLoading}><colgroup>{[40, 88, 100, 118, 90, 92, 136, 116, 140, 156, 72].map((width, index) => <col key={index} style={{ width }} />)}</colgroup><thead><tr>
        <th scope="col" className="log-check-column"><LogSelection label={zh ? "选择当前页全部记录" : "Select all records on this page"} checked={rows.length > 0 && log.selected.length === rows.length} mixed={log.selected.length > 0 && log.selected.length < rows.length} disabled={unavailable || !rows.length} change={log.toggleAll} /></th>
        {[zh ? "访问编号" : "Access ID", zh ? "用户名称" : "User name", zh ? "登录地址" : "IP address", zh ? "登录地点" : "Location", zh ? "浏览器" : "Browser", zh ? "操作系统" : "Operating system", zh ? "登录状态" : "Status", zh ? "操作信息" : "Event information"].map(label => <th key={label} scope="col">{label}</th>)}
        <LogDateHeader locale={locale} label={zh ? "登录日期" : "Login date"} sort={log.sort} change={log.changeSort} /><th scope="col">{zh ? "操作" : "Actions"}</th>
      </tr></thead><tbody>{rows.map(row => <tr key={row.id} aria-selected={log.selected.includes(row.id)}>
        <td className="log-check-column"><LogSelection label={zh ? `选择日志 ${row.id}` : `Select log ${row.id}`} checked={log.selected.includes(row.id)} disabled={unavailable} change={checked => log.toggleRow(row.id, checked)} /></td>
        <td><LogText>{row.id}</LogText></td><td><LogText>{row.account_name || row.account_email}</LogText></td><td><LogText>{row.ip_address || missing}</LogText></td><td>{missing}</td><td><LogText>{row.browser || missing}</LogText></td><td><LogText>{row.os || missing}</LogText></td><td><LogStatus status={row.status || loginLogStatus(row.event)} locale={locale} /></td><td><LogText>{loginEventLabels[row.event]?.[zh ? 0 : 1] || row.event}</LogText></td><td><LogText>{accessTime(row.occurred_at, locale)}</LogText></td><td><button type="button" className="link-button" disabled={log.detailLoading || unavailable} onClick={event => void log.openDetail(row, event.currentTarget)}>{zh ? "详情" : "Details"}</button></td>
      </tr>)}{!rows.length && <tr><td colSpan={11} className="log-empty">{log.loading ? zh ? "正在读取…" : "Loading…" : log.error ? zh ? "读取失败，请重试。" : "Loading failed. Retry." : zh ? "没有符合条件的登录记录。" : "No matching login records."}</td></tr>}</tbody></table></DataListTable>
    </DataList>
    {log.detail && <AdminLoginLogDetail row={log.detail} locale={locale} returnFocus={log.detailReturnFocus} close={() => log.setDetail(null)} />}
    <AdminLogDeletion kind="login" locale={locale} request={deletion} close={() => setDeletion(null)} denied={() => { log.clearPrivateData(); log.setError(zh ? "当前无权管理日志，请重新验证账号权限。" : "You no longer have permission to manage logs."); }} completed={count => { setNotice(zh ? `已永久删除 ${count} 条登录日志，清理操作已记录。` : `${count} login logs permanently deleted. The cleanup was recorded.`); log.refresh(); }} />
  </section>;
}
