"use client";

import { useEffect, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { presenceLabels } from "../lib/account-access";

/** Read the existing administrator-only snapshot; do not infer session state. */
export function onlineAccountCount(data: unknown): number {
  if (!data || typeof data !== "object") throw Error("Invalid presence snapshot");
  const { accounts, updatedAt } = data as { accounts?: unknown; updatedAt?: unknown };
  if (!Array.isArray(accounts) || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) throw Error("Invalid presence snapshot");
  const online = new Set<string>();
  for (const row of accounts) {
    if (!row || typeof row.email !== "string" || !row.email.trim() || typeof row.status !== "string" || !Object.hasOwn(presenceLabels, row.presence)) throw Error("Invalid presence row");
    if (row.status === "active" && row.presence === "online") online.add(row.email.trim().toLowerCase());
  }
  return online.size;
}

export default function AdminOnlineCount({ locale, onOpen }: { locale: "zh" | "en"; onOpen: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false, fetching = false;
    let request: AbortController | undefined;
    const refresh = async () => {
      if (cancelled || fetching || document.visibilityState !== "visible") return;
      fetching = true;
      request = new AbortController();
      try {
        const response = await workspaceFetch("/api/account-access", { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw Error("Presence unavailable");
        const nextCount = onlineAccountCount(await response.json());
        if (!cancelled) { setCount(nextCount); setError(false); }
      } catch {
        // A failed refresh is unknown, not zero or a silently stale online count.
        if (!cancelled) { setCount(null); setError(true); }
      } finally { fetching = false; }
    };
    const kickoff = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    const visible = () => { void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; request?.abort(); window.clearTimeout(kickoff); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, []);
  const zh = locale === "zh";
  return <button type="button" className="admin-online-count" onClick={onOpen} title={zh ? "仅统计在线账号，含管理员；暂离、连接待确认及离线不计入。点击查看账号登录状态。" : "Counts online accounts, including administrators; excludes away, unconfirmed and offline accounts. View account login status."}>
    <span>{zh ? "当前在线人数" : "Accounts online"}</span>
    <strong aria-live="polite" aria-atomic="true">{count ?? "—"}</strong>
    <small>{error ? zh ? "暂不可用，30 秒后重试" : "Unavailable; retrying in 30s" : count === null ? zh ? "正在读取状态…" : "Loading status…" : zh ? "含管理员 · 每 30 秒更新" : "Includes admins · Updates every 30s"}</small>
  </button>;
}
