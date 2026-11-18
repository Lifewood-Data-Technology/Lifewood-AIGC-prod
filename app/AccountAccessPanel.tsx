"use client";
import DataList, { DataListTable } from "./DataList";
import DialogSections from "./DialogSections";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { presenceLabels, loginEventLabels, type AccessRow, type AccessEvent, type PresenceState } from "../lib/account-access";
import { accountDisplayName } from "../lib/business-locale";
import SelectControl from "./SelectControl";
import { SearchIcon } from "./ControlIcons";

const roles: Record<string, [string, string]> = { system: ["管理员", "Administrator"], client: ["销售", "Sales"], project: ["项目负责人", "Project manager"], production: ["剪辑师", "Editor"], quality: ["质检员", "Reviewer"] };
export function accessTime(value: string | null, locale: "zh" | "en") {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}
export function PresenceBadge({ value, locale }: { value: PresenceState; locale: "zh" | "en" }) {
  return <span className={`account-presence-badge ${value}`}><i aria-hidden="true" />{presenceLabels[value][locale === "zh" ? 0 : 1]}</span>;
}

export function LoginHistory({ account, locale, close, released, managed, fresh = true, snapshotAt, statusError, refreshing = false, refreshState, changePassword, enableAccount, releaseBlocked = false, markReleaseUncertain, authorityLost, notice, refreshKey = 0 }: {
  account: AccessRow; locale: "zh" | "en"; close: () => void; released: () => void;
  managed?: Record<string, unknown>; fresh?: boolean; snapshotAt?: string; statusError?: string; refreshing?: boolean;
  refreshState?: () => void; changePassword?: () => void; enableAccount?: () => void;
  releaseBlocked?: boolean; markReleaseUncertain?: () => void; authorityLost?: () => void; notice?: string; refreshKey?: number;
}) {
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const historyPages = Math.max(1, Math.ceil(events.length / 10));
  const currentHistoryPage = Math.min(historyPage, historyPages);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loadedKey, setLoadedKey] = useState(-1);
  const historyBusy = busy || loadedKey !== refreshKey;
  const [reload, setReload] = useState(0);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [reason, setReason] = useState("");
  // IME pinyin can be longer than the final text; it is not a committed release reason.
  const [reasonComposing, setReasonComposing] = useState(false);
  const reasonHintId = useId();
  const reasonReady = reason.trim().length >= 5 && reason.trim().length <= 500;
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const sending = useRef(false);
  const release = async () => {
    if (sending.current || reasonComposing || unconfirmed || releaseBlocked || !fresh || !reasonReady || account.group === "system") return;
    sending.current = true; setReleasing(true); setReleaseError("");
    try {
      const response = await workspaceFetch("/api/accounts", { method: "PATCH", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ targetEmail: account.email, revokeSession: true, reason: reason.trim() }) });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.ok === true) { setReleaseOpen(false); setReason(""); released(); return; }
      if (response.status === 401 || response.status === 403) authorityLost?.();
      if (response.status >= 500 || response.ok || response.status === 401 || response.status === 403 || response.status === 409) { setUnconfirmed(true); markReleaseUncertain?.(); }
      setReleaseError(locale === "zh" ? "解除登录未成功确认，请关闭并刷新状态后核对。" : "Session release is not confirmed. Close and refresh to verify.");
    } catch { setUnconfirmed(true); markReleaseUncertain?.(); setReleaseError(locale === "zh" ? "连接中断，请关闭并刷新状态后核对，勿重复提交。" : "Connection interrupted. Close and refresh to verify before resubmitting."); }
    finally { sending.current = false; setReleasing(false); }
  };
  const dialog = useRef<HTMLDialogElement>(null);
  const zh = locale === "zh";
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    void workspaceFetch(`/api/account-access?email=${encodeURIComponent(account.email)}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
      .then(async response => { if (!response.ok) { if (response.status === 401 || response.status === 403) authorityLost?.(); throw Error(); } const data = await response.json() as { events?: AccessEvent[] }; if (!Array.isArray(data.events)) throw Error(); if (alive) { setEvents(data.events); setError(false); setHistoryPage(1); } })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) { setBusy(false); setLoadedKey(refreshKey); } });
    return () => { alive = false; controller.abort(); };
  }, [account.email, reload, refreshKey, authorityLost]);
  const unknown = zh ? "未记录" : "Not recorded";
  return <dialog ref={dialog} className="account-access-dialog" onCancel={event => { event.preventDefault(); if (!releasing) close(); }} aria-labelledby="account-access-detail-title"><DialogSections>
    <header><div><h2 id="account-access-detail-title">{zh ? "登录详情" : "Login details"} · {accountDisplayName(account.name, account.group, locale)}</h2><p>{account.email}</p></div><button className="secondary-button" disabled={releasing} onClick={close}>{zh ? "关闭" : "Close"}</button></header>
    {!releaseOpen && <div className="account-access-dialog-body">
      {refreshState && <div className="login-details-refresh"><span>{snapshotAt ? `${zh ? "更新于" : "Updated"} ${accessTime(snapshotAt, locale)}` : zh ? "状态未确认" : "Status unconfirmed"}</span><button className="secondary-button" disabled={refreshing || releasing} onClick={refreshState}>{refreshing ? zh ? "正在更新…" : "Refreshing…" : zh ? "刷新状态" : "Refresh status"}</button></div>}
      {notice && <p role="status">{notice}</p>}
      {statusError && <p className="account-access-error" role="alert">{statusError}</p>}
      {releaseBlocked && <p className="account-access-error" role="alert">{zh ? "上次解除结果尚未确认，同一会话不可重复解除。请刷新并核对员工当前状态。" : "The previous release is unconfirmed. Do not release the same session again; refresh and verify the employee's state."}</p>}
      <div className="account-access-detail-grid">
        {managed && <><div><span>{zh ? "账号状态" : "Account status"}</span><strong>{managed.status === "disabled" ? zh ? "已停用，不能登录" : "Disabled; sign-in unavailable" : zh ? "已启用" : "Active"}</strong></div>
        <div><span>{zh ? "首次改密" : "First password change"}</span><strong>{managed.mustChangePassword === true ? zh ? "等待首次修改" : "Change required" : managed.mustChangePassword === false ? zh ? "无需首次改密" : "No change required" : zh ? "状态未确认" : "Status unconfirmed"}</strong></div>
        <div><span>{zh ? "最近登录" : "Last sign-in"}</span><strong>{accessTime(account.lastSignIn, locale)}</strong></div></>}
        <div><span>{zh ? "当前会话" : "Current session"}</span><strong>{!fresh ? zh ? "状态未确认" : "Status unconfirmed" : account.sessionStartedAt ? zh ? "存在登录会话" : "A sign-in session exists" : zh ? "未发现有效会话" : "No active session found"}</strong><PresenceBadge value={fresh ? account.presence : "unknown"} locale={locale} /></div>
      </div>
      <details className="login-connection-details"><summary>{zh ? "查看连接信息" : "View connection details"}</summary><div className="account-access-detail-grid">
        <div><span>{zh ? "本次会话开始" : "Session started"}</span><strong>{accessTime(account.sessionStartedAt, locale)}</strong></div>
        <div><span>{zh ? "本次登录 IP" : "Login IP"}</span><strong>{account.loginIp || unknown}</strong></div>
        <div><span>{zh ? "最近连接 IP" : "Latest connection IP"}</span><strong>{account.currentIp || unknown}</strong></div>
        <div><span>{zh ? "浏览器 / 操作系统" : "Browser / OS"}</span><strong>{[account.browser, account.os].filter(Boolean).join(" / ") || unknown}</strong></div>
        <div><span>{zh ? "最近活动" : "Last activity"}</span><strong>{accessTime(account.lastActivityAt, locale)}</strong></div>
        <div><span>{zh ? "最近连接" : "Last contact"}</span><strong>{accessTime(account.lastContactAt, locale)}</strong></div>
        <div><span>{zh ? "会话最晚到期" : "Session expires by"}</span><strong>{accessTime(account.sessionExpiresAt, locale)}</strong></div>
      </div></details>
      <h3>{zh ? "近期登录记录" : "Recent login history"}</h3>
      <span>{zh ? "近 90 天 · 最多 100 条" : "Last 90 days · Up to 100 events"}</span>
      <p className="account-access-note">{zh ? "以下是发生时的记录，不代表当前仍被锁定；离线也不等于无法登录。" : "These events describe past attempts, not a current lock. Being offline does not mean sign-in is unavailable."}</p>
      {historyBusy ? <p role="status">{zh ? "正在读取…" : "Loading…"}</p> : error ? <p role="alert">{zh ? "记录读取失败，不能据此判断没有记录。" : "Could not load history; this does not mean it is empty."}<button className="link-button" onClick={() => { setBusy(true); setError(false); setEvents([]); setHistoryPage(1); setReload(value => value + 1); }}>{zh ? "重试" : "Retry"}</button></p> :
        <DataListTable ariaLabel={zh ? "近期登录记录" : "Recent login history"}><table className="work-table"><thead><tr>{[zh ? "时间（上海）" : "Time (Shanghai)", zh ? "结果" : "Result", "IP", zh ? "浏览器 / 系统" : "Browser / OS"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>
          {events.slice((currentHistoryPage - 1) * 10, currentHistoryPage * 10).map(event => <tr key={event.id}><td>{accessTime(event.occurred_at, locale)}</td><td>{loginEventLabels[event.event]?.[zh ? 0 : 1] || (zh ? "其他登录事件" : "Other login event")}</td><td>{event.ip_address || unknown}</td><td>{[event.browser, event.os].filter(Boolean).join(" / ") || unknown}</td></tr>)}
          {!events.length && <tr><td colSpan={4}>{zh ? "暂未记录登录事件。" : "No login events recorded yet."}</td></tr>}
        </tbody></table></DataListTable>}
    <div className="account-access-pagination account-history-pagination" aria-label={zh ? "登录记录分页" : "Login history pagination"}>
      <span aria-live="polite">{historyBusy || error ? "—" : zh ? `每页 10 条 · 共 ${events.length} 条 · 第 ${currentHistoryPage} / ${historyPages} 页` : `10 per page · ${events.length} events · Page ${currentHistoryPage} / ${historyPages}`}</span>
      <button className="secondary-button" disabled={historyBusy || error || currentHistoryPage <= 1} onClick={() => setHistoryPage(currentHistoryPage - 1)}>{zh ? "上一页" : "Previous"}</button>
      <button className="secondary-button" disabled={historyBusy || error || currentHistoryPage >= historyPages} onClick={() => setHistoryPage(currentHistoryPage + 1)}>{zh ? "下一页" : "Next"}</button>
    </div>
    </div>}
    {releaseOpen && <section className="account-access-dialog-body admin-session-release" aria-label={zh ? "确认解除登录" : "Confirm session release"}>
      <h3>{zh ? "确认解除登录" : "Confirm session release"}</h3>
      <p>{zh ? "请先确认该员工已停止操作。解除后需要重新登录，密码和草稿保留。" : "Confirm the employee has stopped working. They will need to sign in again; their password and drafts are retained."}</p>
      <label><span>{zh ? "解除原因" : "Release reason"}</span><textarea minLength={5} maxLength={500} value={reason} aria-describedby={reasonHintId} disabled={releasing || unconfirmed || releaseBlocked || !fresh} onChange={event => setReason(event.target.value)} onCompositionStart={() => setReasonComposing(true)} onCompositionEnd={event => { setReason(event.currentTarget.value); setReasonComposing(false); }} /></label>
      <small id={reasonHintId}>{zh ? "至少 5 个字符，最多 500 个字符；首尾空格不计入。" : "Enter at least 5 and at most 500 characters; leading and trailing spaces do not count."}</small>
      {releaseError && <p role="alert">{releaseError}</p>}
    </section>}
    {account.group !== "system" && <footer className="login-detail-actions">{releaseOpen ? <><button className="secondary-button" disabled={releasing} onClick={() => { setReasonComposing(false); setReleaseOpen(false); }}>{zh ? "取消" : "Cancel"}</button><button className="primary-button" disabled={releasing || reasonComposing || unconfirmed || releaseBlocked || !fresh || !reasonReady} onClick={() => void release()}>{releasing ? zh ? "处理中…" : "Processing…" : zh ? "确认解除" : "Confirm release"}</button></> : <>
      {enableAccount && managed?.status === "disabled" && <button className="primary-button" disabled={!fresh || refreshing || unconfirmed || releaseBlocked} onClick={enableAccount}>{zh ? "启用账号" : "Enable account"}</button>}
      {changePassword && <button className="secondary-button" disabled={!fresh || refreshing || unconfirmed || releaseBlocked} onClick={changePassword}>{zh ? "修改密码" : "Change password"}</button>}
      {account.sessionStartedAt && <button className="secondary-button" disabled={unconfirmed || releaseBlocked || !fresh || refreshing} onClick={() => setReleaseOpen(true)}>{zh ? "解除异常登录" : "Release session"}</button>}
    </>}</footer>}

  </DialogSections></dialog>;
}

export default function AccountAccessPanel({ locale, openDetails, refreshKey = 0 }: { locale: "zh" | "en"; openDetails?: (email: string) => void; refreshKey?: number }) {
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const fetching = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const zh = locale === "zh";
  const refresh = useCallback(async () => {
    if (fetching.current || document.visibilityState !== "visible") return;
    fetching.current = true; setBusy(true);
    const request = new AbortController(); controller.current = request;
    try {
      const response = await workspaceFetch("/api/account-access", { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]) });
      if (!response.ok) { if (alive.current && (response.status === 401 || response.status === 403)) { setRows([]); setSelected(null); setUpdatedAt(null); } throw Error(); }
      const data = await response.json() as { accounts?: AccessRow[]; updatedAt?: string }; if (!Array.isArray(data.accounts) || typeof data.updatedAt !== "string") throw Error();
      if (alive.current) { setRows(data.accounts); setUpdatedAt(data.updatedAt); setError(false); }
    } catch { if (alive.current) setError(true); }
    finally { fetching.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    const kickoff = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    const focus = () => { void refresh(); };
    document.addEventListener("visibilitychange", focus);
    return () => { alive.current = false; controller.current?.abort(); window.clearTimeout(kickoff); window.clearInterval(timer); document.removeEventListener("visibilitychange", focus); };
  }, [refresh, refreshKey]);
  const filtered = rows.filter(row => (!role || row.group === role) && (!filter || row.presence === filter) && `${row.name} ${row.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const current = Math.min(page, pages);
  const target = rows.find(row => row.email === selected);
  return <section className="account-access-panel" aria-label={zh ? "账号登录监控" : "Account login monitoring"}>
    {error && <p className="account-access-error" role="alert">{zh ? "状态更新失败，以下可能是旧信息，请重试；不能据此判断员工已离线。" : "Update failed. Any information below may be stale; do not interpret this as employees being offline."}</p>}
    <DataList className="access-data-list admin-list-layout" ariaLabel={zh ? "登录账号" : "Login accounts"} toolbar={<>
      <label className="page-search"><span aria-hidden="true"><SearchIcon /></span><input aria-label={zh ? "搜索登录账号" : "Search login accounts"} placeholder={zh ? "搜索姓名或邮箱…" : "Search name or email…"} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label>
      <label className="admin-filter-field"><span>{zh ? "在线状态" : "Presence"}</span><SelectControl locale={locale} value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}><option value="">{zh ? "全部账号" : "All accounts"}</option>{(Object.keys(presenceLabels) as PresenceState[]).map(state => <option key={state} value={state}>{presenceLabels[state][zh ? 0 : 1]}</option>)}</SelectControl></label>
      <label className="admin-filter-field"><span>{zh ? "角色" : "Role"}</span><SelectControl locale={locale} aria-label={zh ? "登录角色筛选" : "Login role filter"} value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><option value="">{zh ? "全部角色" : "All roles"}</option>{Object.entries(roles).map(([key, label]) => <option key={key} value={key}>{label[zh ? 0 : 1]}</option>)}</SelectControl></label>
      <div className="data-list-query-actions"><button className="secondary-button query-reset-button" onClick={() => { setQuery(""); setFilter(""); setRole(""); setPage(1); }}>{zh ? "重置筛选" : "Reset filters"}</button></div>
    </>} actions={<button className="secondary-button" onClick={() => { void refresh(); }} disabled={busy}>{busy ? zh ? "刷新中…" : "Refreshing…" : zh ? "刷新状态" : "Refresh"}</button>}
      summary={<div className="admin-list-summary"><strong>{zh ? "登录账号" : "Login accounts"} · {filtered.length} / {rows.length}</strong><span>{updatedAt ? `${zh ? "更新于" : "Updated"} ${accessTime(updatedAt, locale)}` : zh ? "等待状态更新" : "Waiting for an update"}</span></div>}
      resultActions={<div className="account-presence-counts admin-presence-filters" role="group" aria-label={zh ? "按登录状态筛选" : "Filter by presence"}>{(Object.keys(presenceLabels) as PresenceState[]).map(state => <button key={state} className={filter === state ? "selected" : ""} aria-pressed={filter === state} onClick={() => { setFilter(filter === state ? "" : state); setPage(1); }}><PresenceBadge value={state} locale={locale} /><strong>{updatedAt ? rows.filter(row => row.presence === state).length : "—"}</strong></button>)}</div>}
      pagination={<div className="account-access-pagination"><span>{zh ? `共 ${filtered.length} 个账号 · 第 ${current} / ${pages} 页` : `${filtered.length} accounts · Page ${current} / ${pages}`}</span><button className="secondary-button" disabled={current <= 1} onClick={() => setPage(current - 1)}>{zh ? "上一页" : "Previous"}</button><button className="secondary-button" disabled={current >= pages} onClick={() => setPage(current + 1)}>{zh ? "下一页" : "Next"}</button></div>}>
    <DataListTable ariaLabel={zh ? "登录账号" : "Login accounts"}><table className="work-table account-access-table"><thead><tr>{[zh ? "姓名 / 邮箱" : "Name / Email", zh ? "角色" : "Role", zh ? "在线状态" : "Presence", zh ? "最近活动" : "Last activity", zh ? "最近登录" : "Last sign-in", zh ? "操作" : "Actions"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>
      {filtered.slice((current - 1) * 20, current * 20).map(row => <tr key={row.email}><td><strong>{accountDisplayName(row.name, row.group, locale)}</strong><small>{row.email}{row.status === "disabled" ? zh ? " · 已停用" : " · Disabled" : ""}</small></td><td>{roles[row.group]?.[zh ? 0 : 1] || row.group}</td><td><PresenceBadge value={row.presence} locale={locale} /></td><td>{accessTime(row.lastActivityAt, locale)}</td><td>{accessTime(row.lastSignIn, locale)}</td><td><button className="link-button" onClick={() => openDetails ? openDetails(row.email) : setSelected(row.email)}>{zh ? "登录详情" : "Login details"}</button></td></tr>)}
      {!filtered.length && <tr><td colSpan={6}>{busy && !updatedAt ? zh ? "正在读取状态…" : "Loading status…" : error ? zh ? "状态暂不可用。" : "Status unavailable." : zh ? "没有符合条件的账号。" : "No matching accounts."}</td></tr>}
    </tbody></table></DataListTable>
    </DataList>
    {target && <LoginHistory key={target.email} account={target} locale={locale} close={() => setSelected(null)} released={() => { setSelected(null); void refresh(); }} />}
  </section>;
}
