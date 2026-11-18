"use client";
import { useEffect, useRef, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
import type { LogLocale } from "./AdminLogControls";
type LogRecord = { id: string | number };
type Page<T> = { rows: T[]; total: number; page: number; pageSize: number; actions?: string[] };
export function logParams(filters: Record<string, string>) { return new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== "")); }
export default function useLogRecords<T extends LogRecord>({ endpoint, locale, initialFilters, validRow }: { endpoint: string; locale: LogLocale; initialFilters: Record<string, string>; validRow: (value: unknown) => value is T }) {
  const zh = locale === "zh";
  const [filters, setFilters] = useState(initialFilters), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10), [sort, setSort] = useState<"asc" | "desc">("desc"), [version, setVersion] = useState(0);
  const [data, setData] = useState<Page<T> | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [detail, setDetail] = useState<T | null>(null), [detailLoading, setDetailLoading] = useState(false), [exporting, setExporting] = useState(false);
  const [detailReturnFocus, setDetailReturnFocus] = useState<HTMLElement | null>(null);
  const mounted = useRef(true), detailRequest = useRef<AbortController | null>(null), exportRequest = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; detailRequest.current?.abort(); exportRequest.current?.abort(); }; }, []);
  function clearPrivateData() { setData(null); setDetail(null); setSelected([]); }
  useEffect(() => {
    const controller = new AbortController();
    const params = logParams({ ...filters, page: String(page), pageSize: String(pageSize), sort });
    void workspaceFetch(`${endpoint}?${params}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) }).then(async response => {
      if (!response.ok) { if ([401, 403].includes(response.status) && !controller.signal.aborted) { setData(null); setDetail(null); setSelected([]); } throw Error(); }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows) || !result.rows.every(validRow) || !("total" in result) || !Number.isSafeInteger(result.total) || Number(result.total) < 0 || !("page" in result) || !Number.isSafeInteger(result.page) || Number(result.page) < 1 || !("pageSize" in result) || ![10, 20, 50, 100].includes(Number(result.pageSize))) throw Error();
      if (!controller.signal.aborted) setData({ rows: result.rows, total: Number(result.total), page: Number(result.page), pageSize: Number(result.pageSize), actions: "actions" in result && Array.isArray(result.actions) ? result.actions.filter((action): action is string => typeof action === "string") : undefined });
    }).catch(() => { if (!controller.signal.aborted) setError(zh ? "日志读取失败，请重试。" : "Could not load log records. Please retry."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, filters, page, pageSize, sort, version, validRow, zh]);
  function begin() { detailRequest.current?.abort(); setLoading(true); setError(""); setSelected([]); setDetail(null); setDetailLoading(false); }
  function refresh() { begin(); setVersion(value => value + 1); }
  function apply(next: Record<string, string>) { begin(); setFilters(Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value.trim()]))); setPage(1); setVersion(value => value + 1); }
  async function openDetail(row: T, trigger?: HTMLElement) {
    setDetailReturnFocus(trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller; setDetailLoading(true); setError("");
    try {
      const response = await workspaceFetch(`${endpoint}?${new URLSearchParams({ detailId: String(row.id) })}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
      if (controller.signal.aborted) return;
      if (!response.ok) { if ([401, 403].includes(response.status)) clearPrivateData(); throw Error(response.status === 404 ? zh ? "此记录已删除或不在可查询范围内，请刷新列表。" : "This record was deleted or is outside the available range. Refresh the list." : zh ? "详情读取失败，请重试。" : "Could not load details. Retry."); }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("row" in result) || !validRow(result.row)) throw Error(zh ? "详情读取失败，请重试。" : "Could not load details. Retry.");
      if (!controller.signal.aborted && mounted.current) setDetail(result.row);
    } catch (cause) { if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : zh ? "详情读取失败，请重试。" : "Could not load details. Retry."); }
    finally { if (!controller.signal.aborted && mounted.current) setDetailLoading(false); }
  }
  async function exportCsv() {
    if (exporting) return; const controller = new AbortController(); exportRequest.current = controller; setExporting(true); setError("");
    try {
      const params = logParams({ ...filters, sort, format: "csv", ...(selected.length ? { ids: selected.join(",") } : {}) });
      const response = await workspaceFetch(`${endpoint}?${params}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (controller.signal.aborted) return;
      if (!response.ok) { if ([401, 403].includes(response.status)) { clearPrivateData(); throw Error(zh ? "当前无权导出日志。" : "You no longer have access to export logs."); } throw Error(response.status === 400 ? zh ? "筛选条件无效或记录超过一万条，请缩小范围后重试。" : "Invalid filters or more than 10,000 records. Narrow the range and retry." : zh ? "导出失败，请稍后重试。" : "Export failed. Please retry."); }
      const blob = await response.blob(); if (controller.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = endpoint.includes("login") ? "login-history.csv" : "operation-log.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) { if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : zh ? "导出失败" : "Export failed"); }
    finally { if (!controller.signal.aborted && mounted.current) setExporting(false); }
  }
  return { filters, sort, data, loading, error, setError, selected, setSelected, detail, setDetail, detailReturnFocus, detailLoading, exporting, pageSize, refresh, apply, openDetail, exportCsv,
    current: data?.page || page, pages: Math.max(1, Math.ceil((data?.total || 0) / pageSize)),
    changePage(next: number) { begin(); setPage(next); }, changeSize(size: number) { begin(); setPageSize(size); setPage(1); }, changeSort() { begin(); setSort(value => value === "asc" ? "desc" : "asc"); setPage(1); },
    toggleRow(id: string, checked: boolean) { setSelected(ids => checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id)); },
    toggleAll(checked: boolean) { setSelected(checked ? data?.rows.map(row => String(row.id)) || [] : []); }, clearPrivateData };
}
