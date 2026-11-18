"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
import type { AccessRow } from "../lib/account-access";
import { LoginHistory } from "./AccountAccessPanel";
import DialogSections from "./DialogSections";

type Row = Record<string, unknown>;
type Snapshot = { managed: Row; access: AccessRow; updatedAt: string };
export default function AccountLoginDetails({ email, locale, close, changePassword, enableAccount, changed, releaseLocks }: {
  email: string; locale: "zh" | "en"; close: () => void;
  changePassword: (account: Row) => void; enableAccount: (account: Row) => void; changed: () => void;
  releaseLocks: Set<string>;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const pending = useRef(false), alive = useRef(true), controller = useRef<AbortController | null>(null);
  const zh = locale === "zh";
  const deny = useCallback(() => { setSnapshot(null); setForbidden(true); setError(true); }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setClock(Date.now());
    const request = new AbortController(); controller.current = request;
    const options = { cache: "no-store" as const, signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]) };
    const results = await Promise.allSettled(["/api/accounts", "/api/account-access"].map(async url => {
      const response = await workspaceFetch(url, options);
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "forbidden" : "unavailable");
      return response.json();
    }));
    if (alive.current) {
      if (results.some(result => result.status === "rejected" && result.reason?.message === "forbidden")) deny();
      else if (results.every(result => result.status === "fulfilled")) {
        const [accounts, access] = results.map(result => result.status === "fulfilled" ? result.value : null);
        const managed = Array.isArray(accounts?.accounts) ? accounts.accounts.find((row: Row) => row.email === email) : null;
        const presence = Array.isArray(access?.accounts) ? access.accounts.find((row: AccessRow) => row.email === email) : null;
        const stamp = Date.parse(access?.updatedAt);
        if (managed && presence && managed.group === presence.group && managed.status === presence.status && typeof managed.mustChangePassword === "boolean" && Number.isFinite(managed.revision) && Number.isFinite(stamp) && Math.abs(Date.now() - stamp) < 60_000) {
          setSnapshot({ managed, access: presence, updatedAt: access.updatedAt }); setError(false); setForbidden(false);
        } else setError(true);
      } else setError(true);
      setBusy(false);
    }
    pending.current = false;
  }, [email, deny]);
  useEffect(() => {
    alive.current = true;
    const kickoff = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { setClock(Date.now()); if (document.visibilityState === "visible") void load(); }, 30_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; controller.current?.abort(); window.clearTimeout(kickoff); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  const refresh = () => { setHistoryKey(key => key + 1); void load(); };
  if (!snapshot || forbidden) return <LoginDetailsPending locale={locale} email={forbidden ? "" : email} busy={busy} close={close} retry={load} />;
  const sessionKey = `${email}:${snapshot.access.sessionStartedAt ?? "none"}`;
  const fresh = !error && !busy && clock - Date.parse(snapshot.updatedAt) < 60_000;
  return <LoginHistory account={snapshot.access} managed={snapshot.managed} locale={locale} close={close}
    fresh={fresh} snapshotAt={snapshot.updatedAt} refreshing={busy} refreshState={refresh} refreshKey={historyKey}
    statusError={error ? zh ? "状态未确认：更新失败，以下可能是旧信息。请刷新核对后再操作。" : "Status unconfirmed: the update failed and information below may be stale. Refresh before taking action." : undefined}
    changePassword={() => { if (fresh && Date.now() - Date.parse(snapshot.updatedAt) < 60_000) changePassword(snapshot.managed); }} enableAccount={() => { if (fresh && Date.now() - Date.parse(snapshot.updatedAt) < 60_000) enableAccount(snapshot.managed); }}
    releaseBlocked={releaseLocks.has(sessionKey)} markReleaseUncertain={() => releaseLocks.add(sessionKey)} authorityLost={deny}
    notice={notice} released={() => { setNotice(zh ? "已解除该员工的登录会话。" : "The employee's session was released."); changed(); refresh(); }} />;
}
function LoginDetailsPending({ locale, email, busy, close, retry }: { locale: "zh" | "en"; email: string; busy: boolean; close: () => void; retry: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), zh = locale === "zh";
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={ref} className="account-access-dialog" aria-label={zh ? "登录详情" : "Login details"} onCancel={event => { event.preventDefault(); close(); }}><DialogSections>
    <header><div><h2>{zh ? "登录详情" : "Login details"}</h2>{email && <p>{email}</p>}</div><button className="secondary-button" onClick={close}>{zh ? "关闭" : "Close"}</button></header>
    <div className="account-access-dialog-body"><p role={busy ? "status" : "alert"}>{busy ? zh ? "正在读取账号和会话状态…" : "Loading account and session status…" : zh ? "状态未确认：信息不可用或管理权限已改变，请刷新后核对。" : "Status unconfirmed: information is unavailable or management access changed. Refresh to verify."}</p></div>
    <footer><button className="secondary-button" disabled={busy} onClick={retry}>{zh ? "刷新状态" : "Refresh status"}</button></footer>
  </DialogSections></dialog>;
}
