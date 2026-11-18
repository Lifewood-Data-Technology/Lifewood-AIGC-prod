"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { validLogSubmissionId, type LogKind, type LogDeletionPreview } from "../lib/admin-log-deletion";
import { useDraftOwner, useDraftRisk } from "./useLocalDraft";
import LogDetailDialog, { LogDetailFields } from "./LogDetailDialog";
import type { LogLocale } from "./AdminLogControls";
type Request = { ids?: string[]; filters: Record<string, string> };
type Pending = { submissionId: string; previewId: string; count: number; at: number };
const errorNames: Record<string, [string, string]> = {
  LOG_PREVIEW_EXPIRED: ["预览已过期，请关闭后重新预览。", "The preview expired. Close and preview again."],
  LOG_SELECTION_CHANGED: ["记录已发生变化，请关闭后重新预览。", "The selected records changed. Close and preview again."],
  LOG_DELETE_TOO_LARGE: ["筛选结果超过一万条，请缩小范围。", "More than 10,000 records match. Narrow the filters."],
  LOG_SUBMISSION_CONFLICT: ["提交编号与原操作不一致，请核对原提交。", "The submission does not match the original operation. Verify it first."],
};
function readPending(key: string): Pending | null {
  try { const value = JSON.parse(window.sessionStorage.getItem(key) || "null"); return value && validLogSubmissionId(value.submissionId) && validLogSubmissionId(value.previewId) && Number.isSafeInteger(value.count) && typeof value.at === "number" ? value : null; } catch { return null; }
}
function previewValid(value: unknown): value is LogDeletionPreview { return !!value && typeof value === "object" && "previewId" in value && validLogSubmissionId(value.previewId) && "count" in value && Number.isSafeInteger(value.count) && Number(value.count) > 0 && "expiresAt" in value && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)) && "summary" in value && typeof value.summary === "string"; }
function scopeFields(summary: string, zh: boolean): [string, string][] {
  try {
    const value: unknown = JSON.parse(summary);
    if (!value || typeof value !== "object" || !("scope" in value)) return [];
    const fields: [string, string][] = [[zh ? "删除范围" : "Scope", value.scope === "selected" ? zh ? "当前页所选记录" : "Selected records on this page" : zh ? "当前筛选结果（所有分页）" : "Filtered records across all pages"]];
    const labels: Record<string, [string, string]> = { module: ["系统模块", "Module"], actor: ["操作人员", "Actor"], query: ["关键字", "Keyword"], email: ["用户邮箱", "Email"], ip: ["地址", "IP address"], status: ["状态", "Status"], action: ["操作类型", "Operation"], event: ["登录事件", "Login event"], start: ["开始日期", "Start date"], end: ["结束日期", "End date"] };
    if ("filters" in value && value.filters && typeof value.filters === "object") for (const [key, text] of Object.entries(value.filters)) if (typeof text === "string" && text && labels[key]) fields.push([labels[key][zh ? 0 : 1], text]);
    return fields;
  } catch { return []; }
}
/** Retain only request identity, never log bodies; uncertain writes must be checked before retrying. */
export default function AdminLogDeletion({ kind, locale, request, close, completed, denied }: { kind: LogKind; locale: LogLocale; request: Request | null; close: () => void; completed: (count: number) => void; denied: () => void }) {
  const zh = locale === "zh", owner = useDraftOwner(), key = `lifewood-log-deletion:${owner}:${kind}`;
  const [pending, setPending] = useState<Pending | null>(() => readPending(key)), [preview, setPreview] = useState<LogDeletionPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmation, setConfirmation] = useState(""), [verifiedAbsent, setVerifiedAbsent] = useState(false), [dismissed, setDismissed] = useState(false);
  const alive = useRef(true), running = useRef(false);
  const [currentRequest, setCurrentRequest] = useState(request);
  if (currentRequest !== request) { setCurrentRequest(request); if (request) setDismissed(false); if (request && !pending) { setBusy(true); setError(""); setPreview(null); setConfirmation(""); } }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useDraftRisk(busy || !!pending);
  function clearPending() { try { window.sessionStorage.removeItem(key); } catch { /* The authorization check still protects any retained identity. */ } setPending(null); }
  function unauthorized() { clearPending(); setPreview(null); setError(zh ? "当前无权管理日志，请重新验证账号权限。" : "You no longer have permission to manage logs."); denied(); close(); }
  function finish(count: number) { clearPending(); setPreview(null); setConfirmation(""); setVerifiedAbsent(false); close(); completed(count); }
  const previewDenied = useEffectEvent(() => { clearPending(); denied(); close(); });
  const canPreview = useEffectEvent(() => !pending);
  useEffect(() => {
    if (!request || !canPreview()) return;
    const controller = new AbortController();
    void workspaceFetch("/api/admin-logs/deletion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", kind, ...request }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) }).then(async response => {
      if (controller.signal.aborted) return;
      if ([401, 403].includes(response.status)) { previewDenied(); throw Error(zh ? "当前无权管理日志。" : "You no longer have permission to manage logs."); }
      const result: unknown = await response.json(); if (controller.signal.aborted) return;
      if (!response.ok) { const code = result && typeof result === "object" && "code" in result && typeof result.code === "string" ? result.code : ""; throw Error(errorNames[code]?.[zh ? 0 : 1] || (zh ? "删除预览失败，请关闭后重试。" : "Could not preview deletion. Close and retry.")); }
      if (!previewValid(result)) throw Error(zh ? "删除预览响应无效，请关闭后重试。" : "The deletion preview is invalid. Close and retry.");
      setPreview(result);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [request, kind, zh]);
  async function verify() {
    if (!pending || running.current) return; running.current = true; setBusy(true); setError("");
    try {
      const response = await workspaceFetch(`/api/admin-logs/deletion?${new URLSearchParams({ submissionId: pending.submissionId, kind })}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!alive.current) return;
      if ([401, 403].includes(response.status)) { unauthorized(); return; }
      const result: unknown = await response.json(); if (!alive.current) return;
      if (!response.ok || !result || typeof result !== "object" || !("status" in result)) throw Error();
      if (result.status === "completed" && "deletedCount" in result && Number.isSafeInteger(result.deletedCount)) { finish(Number(result.deletedCount)); return; }
      if (result.status === "not_found") { setVerifiedAbsent(true); setError(zh ? "尚未找到完成回执。可使用原提交编号重试，服务端会防止重复删除。" : "No completion receipt was found. Retry the original submission; the server prevents duplicate deletion."); return; }
      throw Error();
    } catch { if (alive.current) setError(zh ? "暂时无法核对原提交，请稍后再次核对。不要重新发起删除。" : "The original submission could not be verified. Check again later; do not start another deletion."); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function execute() {
    if (running.current || (!pending && (!preview || confirmation !== "永久删除"))) return;
    if (!pending && preview && Date.parse(preview.expiresAt) <= Date.now()) { setError(errorNames.LOG_PREVIEW_EXPIRED[zh ? 0 : 1]); return; }
    const identity = pending || (preview ? { submissionId: crypto.randomUUID(), previewId: preview.previewId, count: preview.count, at: Date.now() } : null); if (!identity) return;
    try { window.sessionStorage.setItem(key, JSON.stringify(identity)); } catch { setError(zh ? "浏览器无法保存提交编号，请恢复浏览器存储后再操作；尚未发送删除请求。" : "The browser cannot retain the submission ID. Restore browser storage before deleting; no request was sent."); return; }
    setPending(identity); setVerifiedAbsent(false); running.current = true; setBusy(true); setError("");
    try {
      const response = await workspaceFetch("/api/admin-logs/deletion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "execute", previewId: identity.previewId, submissionId: identity.submissionId, confirmation: "永久删除" }), signal: AbortSignal.timeout(20_000) });
      if (!alive.current) return;
      if ([401, 403].includes(response.status)) { unauthorized(); return; }
      const result: unknown = await response.json(); if (!alive.current) return;
      if (response.ok && result && typeof result === "object" && "status" in result && result.status === "completed" && "deletedCount" in result && Number.isSafeInteger(result.deletedCount)) { finish(Number(result.deletedCount)); return; }
      const code = result && typeof result === "object" && "code" in result && typeof result.code === "string" ? result.code : "";
      if (["LOG_PREVIEW_EXPIRED", "LOG_SELECTION_CHANGED", "LOG_DELETE_TOO_LARGE"].includes(code)) { clearPending(); setPreview(null); setError(errorNames[code][zh ? 0 : 1]); return; }
      setError(zh ? "删除结果尚未确认，请先核对原提交。" : "Deletion is not confirmed. Verify the original submission first.");
    } catch { if (alive.current) setError(zh ? "请求超时或响应丢失，删除结果待核对。请核对原提交，不要重新发起删除。" : "The response was lost or timed out. Verify the original submission before taking any further action."); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  if ((!request && !pending) || dismissed) return pending ? <p className="log-notice" role="status">{zh ? "有一项日志删除结果待核对。" : "A log deletion is awaiting verification."}<button type="button" className="link-button" onClick={() => setDismissed(false)}>{zh ? "核对原提交" : "Verify original submission"}</button></p> : null;
  const closeDialog = () => { if (busy) return; if (pending) setDismissed(true); else { setPreview(null); setError(""); } close(); };
  return <LogDetailDialog locale={locale} title={zh ? "永久删除日志" : "Permanently delete logs"} close={closeDialog} busy={busy} footer={<><button type="button" className="secondary-button" disabled={busy} onClick={closeDialog}>{zh ? "关闭" : "Close"}</button>{pending ? <><button type="button" className="primary-button" disabled={busy} onClick={() => void verify()}>{busy ? zh ? "核对中…" : "Checking…" : zh ? "核对原提交" : "Verify original submission"}</button>{verifiedAbsent && <button type="button" className="log-danger-button" disabled={busy} onClick={() => void execute()}>{zh ? "使用原编号重试" : "Retry original submission"}</button>}</> : <button type="button" className="log-danger-button" disabled={busy || !preview || confirmation !== "永久删除"} onClick={() => void execute()}>{zh ? "确认永久删除" : "Confirm permanent deletion"}</button>}</>}>
    <p className="log-delete-warning">{zh ? "日志删除后无法恢复。此操作不会删除账号、解除会话或重置登录限制。" : "Deleted logs cannot be restored. This does not delete accounts, release sessions or reset login limits."}</p>
    {busy && !preview && !pending && <p role="status">{zh ? "正在核对删除范围…" : "Verifying the deletion scope…"}</p>}
    {(preview || pending) && <LogDetailFields missing={zh ? "未记录" : "Not recorded"} fields={[[zh ? "记录类型" : "Record type", kind === "audit" ? zh ? "操作日志" : "Operation logs" : zh ? "登录日志" : "Login logs"], [zh ? "冻结记录数量" : "Frozen record count", String(preview?.count ?? pending?.count ?? 0)], ...(preview ? scopeFields(preview.summary, zh) : []), ...(pending ? [[zh ? "原提交编号" : "Original submission ID", pending.submissionId] as [string, string]] : [])]} />}
    {preview && !pending && <><p className="log-muted">{zh ? "仅删除本次预览锁定的记录；之后产生的新日志不会被删除。预览有效期 5 分钟。" : "Only records frozen by this preview will be deleted; newer logs are excluded. The preview is valid for 5 minutes."}</p><label className="log-confirmation">{zh ? "请输入“永久删除”确认" : "Type “永久删除” to confirm"}<input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label></>}
    {error && <p className="log-error" role="alert">{error}</p>}
  </LogDetailDialog>;
}
