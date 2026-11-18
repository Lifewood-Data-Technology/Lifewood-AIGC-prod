"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SearchIcon } from "./ControlIcons";
export type LogLocale = "zh" | "en";
export function LogIcon({ name }: { name: "refresh" | "delete" | "export" | "search" }) {
  if (name === "search") return <SearchIcon />;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={name === "refresh" ? "M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7l-3-3" : name === "delete" ? "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" : "M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"} /></svg>;
}
export function LogText({ children }: { children: string }) {
  const id = useId(), [host, setHost] = useState<HTMLElement | null>(null), [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const open = (node: HTMLElement) => { setHost(node.closest<HTMLElement>(".app-shell")); const rect = node.getBoundingClientRect(); setAnchor({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)), top: Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - 172)) }); };
  useEffect(() => { if (!anchor) return; const close = () => setAnchor(null); window.addEventListener("scroll", close, true); window.addEventListener("resize", close); return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); }; }, [anchor]);
  return <><button type="button" className="log-cell-value" onClick={event => open(event.currentTarget)} title={children} aria-describedby={anchor ? id : undefined} onMouseEnter={event => open(event.currentTarget)} onMouseLeave={() => setAnchor(null)} onFocus={event => open(event.currentTarget)} onBlur={() => setAnchor(null)} onKeyDown={event => { if (event.key === "Escape") setAnchor(null); }}>{children}</button>{anchor && createPortal(<span id={id} className="log-cell-tooltip" role="tooltip" style={anchor}>{children}</span>, host || document.body)}</>;
}
const statusNames: Record<string, [string, string]> = { success: ["成功", "Success"], failure: ["失败", "Failed"], unconfirmed: ["待核对", "Unconfirmed"], blocked: ["已阻止", "Blocked"], signed_out: ["已退出", "Signed out"] };
export function logStatusLabel(status: string | null | undefined, locale: LogLocale) { return status && statusNames[status] ? statusNames[status][locale === "zh" ? 0 : 1] : locale === "zh" ? "未记录" : "Not recorded"; }
export function LogStatus({ status, locale }: { status: string | null | undefined; locale: LogLocale }) { return <span className={`log-status log-status-${status && statusNames[status] ? status : "unknown"}`}>{logStatusLabel(status, locale)}</span>; }
export function LogSelection({ checked, mixed = false, label, disabled, change }: { checked: boolean; mixed?: boolean; label: string; disabled?: boolean; change: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} disabled={disabled} onChange={event => change(event.target.checked)} />;
}
export function LogToolbar({ locale, selected, total, busy, readOnly = false, exporting, filtersVisible, toggleFilters, refresh, remove, clear, exportCsv }: {
  locale: LogLocale; selected: number; total: number; busy: boolean; readOnly?: boolean; exporting: boolean; filtersVisible: boolean;
  toggleFilters: () => void; refresh: () => void; remove: () => void; clear: () => void; exportCsv: () => void;
}) {
  const zh = locale === "zh", toggleLabel = filtersVisible ? zh ? "收起筛选" : "Hide filters" : zh ? "展开筛选" : "Show filters";
  return <div className="log-toolbar"><div className="log-toolbar-actions">
    <button type="button" className="log-danger-button" disabled={busy || readOnly || !selected} onClick={remove}><LogIcon name="delete" />{zh ? "删除" : "Delete"}</button>
    <button type="button" className="log-danger-button" disabled={busy || readOnly || !total} onClick={clear}>{zh ? "清空筛选结果" : "Clear filtered results"}</button>
    <button type="button" className="log-export-button" disabled={busy || readOnly || exporting || !total} title={selected ? zh ? `导出所选 ${selected} 条记录` : `Export ${selected} selected records` : zh ? "导出当前筛选结果" : "Export the current filtered results"} onClick={exportCsv}><LogIcon name="export" />{exporting ? zh ? "导出中…" : "Exporting…" : zh ? "导出" : "Export"}</button>
  </div><div className="log-toolbar-utilities"><button type="button" className="log-icon-button" aria-label={toggleLabel} title={toggleLabel} aria-expanded={filtersVisible} onClick={toggleFilters}><LogIcon name="search" /></button><button type="button" className="log-icon-button" aria-label={zh ? "刷新" : "Refresh"} title={zh ? "刷新" : "Refresh"} disabled={busy} onClick={refresh}><LogIcon name="refresh" /></button></div></div>;
}
export function LogDateRange({ locale, label, start, end, change }: { locale: LogLocale; label: string; start: string; end: string; change: (key: "start" | "end", value: string) => void }) {
  const zh = locale === "zh";
  return <div className="log-date-range" role="group" aria-label={label}><span>{label}</span><label><span className="visually-hidden">{zh ? "开始日期" : "Start date"}</span><input type="date" value={start} onChange={event => change("start", event.target.value)} /></label><span aria-hidden="true">—</span><label><span className="visually-hidden">{zh ? "结束日期" : "End date"}</span><input type="date" value={end} onChange={event => change("end", event.target.value)} /></label></div>;
}
export function LogPagination({ locale, page, pages, pageSize, total, selected, busy, setPage, setSize }: { locale: LogLocale; page: number; pages: number; pageSize: number; total: number; selected: number; busy: boolean; setPage: (page: number) => void; setSize: (size: number) => void }) {
  const zh = locale === "zh";
  return <div className="log-pagination"><span>{zh ? `已选 ${selected} 项 · 共 ${total} 条` : `${selected} selected · ${total} records`}</span><label><span className="visually-hidden">{zh ? "每页条数" : "Rows per page"}</span><select value={pageSize} disabled={busy} onChange={event => setSize(Number(event.target.value))}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{zh ? `${size}条/页` : `${size}/page`}</option>)}</select></label><button type="button" className="log-page-button" aria-label={zh ? "上一页" : "Previous"} disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="log-current-page" aria-current="page">{page}</span><button type="button" className="log-page-button" aria-label={zh ? "下一页" : "Next"} disabled={busy || page >= pages} onClick={() => setPage(page + 1)}>›</button><span>{zh ? `共 ${pages} 页` : `${pages} pages`}</span></div>;
}
export function LogDateHeader({ locale, label, sort, change }: { locale: LogLocale; label: string; sort: "asc" | "desc"; change: () => void }) {
  return <th scope="col" aria-sort={sort === "asc" ? "ascending" : "descending"}><button type="button" className="log-sort-button" onClick={change} title={locale === "zh" ? `按日期${sort === "desc" ? "升序" : "降序"}排列` : `Sort date ${sort === "desc" ? "ascending" : "descending"}`}>{label}<span aria-hidden="true">{sort === "desc" ? "↓" : "↑"}</span></button></th>;
}
