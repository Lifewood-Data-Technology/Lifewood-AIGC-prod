"use client";
import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { acknowledgeSubmissionWarnings, hasUnconfirmedSubmission, unacknowledgedSubmissionWarnings } from "../lib/submission-client";

export const DraftOwner = createContext("");
export const useDraftOwner = () => useContext(DraftOwner);
const lifetime = 7 * 86400000;
const prefixes = ["lifewood-form-draft:", "lifewood-quality-draft:", "lifewood-planning:", "lifewood-checkpoint-draft:"];
const risks = new Set<symbol>();
const exitRisks = new Set<symbol>();
export function useDraftRisk(risk: boolean, scope: "all" | "exit" = "all") {
  const release = useRef<() => void>(() => {});
  useEffect(() => {
    const id = Symbol();
    const collection = scope === "exit" ? exitRisks : risks;
    if (risk) collection.add(id);
    const warn = (event: BeforeUnloadEvent) => {
      if (risk || hasUnconfirmedSubmission()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    const clear = () => { collection.delete(id); window.removeEventListener("beforeunload", warn); };
    release.current = clear;
    return clear;
  }, [risk, scope]);
  // A server-confirmed operation can settle its own risk before invoking navigation callbacks.
  // Other forms and unresolved submissions retain their separate registrations.
  return useCallback(() => release.current(), []);
}
export function mayLeaveDrafts(locale: "zh" | "en", destination: "navigation" | "exit" = "navigation") {
  const warnings = unacknowledgedSubmissionWarnings();
  if (!risks.size && !(destination === "exit" && exitRisks.size) && !(destination === "exit" ? hasUnconfirmedSubmission() : warnings.length)) return true;
  const accepted = window.confirm(locale === "zh"
    ? "有未能暂存的输入、未完成上传或尚未确认的提交。离开前建议保存文字并核对结果。仍要离开吗？"
    : "Some input, uploads or submissions are not confirmed saved. Preserve your text and verify the result before leaving. Leave anyway?");
  if (accepted && destination === "navigation") acknowledgeSubmissionWarnings(warnings);
  return accepted;
}

export function readLocalDraft<T>(key: string, sanitize: (value: unknown) => T | null): { at: number; value: T } | null {
  if (!key || typeof window === "undefined") return null;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index--) {
      const other = window.localStorage.key(index);
      if (!other || !prefixes.some(prefix => other.startsWith(prefix))) continue;
      try {
        const data = JSON.parse(window.localStorage.getItem(other) || "null");
        const rawTime = data?.at ?? data?.savedAt ?? data?.clientUpdatedAt;
        const at = typeof rawTime === "string" && !/^\d+$/.test(rawTime) ? Date.parse(rawTime) : Number(rawTime);
        if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > lifetime) window.localStorage.removeItem(other);
      } catch { window.localStorage.removeItem(other); }
    }
    const data = JSON.parse(window.localStorage.getItem(key) || "null");
    if (data?.version !== 1 || !Number.isFinite(data.at) || data.at > Date.now() || Date.now() - data.at > lifetime) return null;
    const value = sanitize(data.value);
    return value === null ? null : { at: data.at, value };
  } catch { return null; }
}

/** Saving is synchronous with edits: closing immediately after a keystroke is safe. */
export function useLocalDraft<T>(key: string, empty: T, sanitize: (value: unknown) => T | null) {
  const initial = () => ({ key, value: empty, pending: readLocalDraft(key, sanitize), at: 0, dirty: false, failed: false, generation: 0 });
  const [entry, setEntry] = useState(initial);
  const current = useRef(entry);
  useDraftRisk(entry.dirty && entry.failed);
  if (entry.key !== key) setEntry(initial());
  useLayoutEffect(() => { current.current = entry; }, [entry]);
  const save = (next: typeof entry) => {
    if (key) try {
      if (next.dirty) window.localStorage.setItem(key, JSON.stringify({ version: 1, at: next.at, value: next.value }));
      else window.localStorage.removeItem(key);
      next.failed = false;
    } catch { next.failed = true; }
    current.current = next;
    setEntry(next);
  };
  const setValue = (value: SetStateAction<T>) => {
    const previous = current.current;
    // A stored draft must be restored/discarded explicitly, never overwritten by mounting.
    if (previous.pending) return;
    save({ ...previous, value: typeof value === "function" ? (value as (old: T) => T)(previous.value) : value, at: Date.now(), dirty: true });
  };
  const restore = () => {
    const previous = current.current;
    if (!previous.pending) return;
    save({ ...previous, value: previous.pending.value, pending: null, dirty: true, at: Date.now(), generation: previous.generation + 1 });
  };
  const clear = () => save({ ...current.current, value: empty, pending: null, dirty: false, at: 0, generation: current.current.generation + 1 });
  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => {
      if (current.current.failed && current.current.dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warning);
    return () => window.removeEventListener("beforeunload", warning);
  }, []);
  return { ...entry, setValue, restore, clear };
}

export function DraftNotice({ draft, locale, hasFileUploads = true }: { draft: { pending: { at: number } | null; failed: boolean; dirty: boolean; at: number; restore: () => void; clear: () => void }; locale: "zh" | "en"; hasFileUploads?: boolean }) {
  const zh = locale === "zh";
  const time = draft.pending?.at || draft.at;
  return <div className="local-draft-notice" role={draft.failed ? "alert" : "status"}>
    <span>{draft.pending
      ? (zh ? "发现本浏览器的未提交草稿，请选择恢复或丢弃。" : "An unsubmitted draft exists in this browser. Restore or discard it.")
      : draft.failed ? (zh ? "草稿暂存失败，请勿关闭页面。请正式保存或复制文字后再离开。" : "Draft could not be stored. Save formally or copy your text before leaving.")
      : draft.dirty ? (zh ? "已暂存到本浏览器 · 尚未正式提交" : "Stored in this browser · Not submitted")
      : (zh ? "输入后自动暂存到本浏览器，保留 7 天；提交成功才写入正式记录。" : "Edits are stored in this browser for 7 days. Only a successful submission creates an official record.")}
      {time > 0 && <small> · {new Date(time).toLocaleString(zh ? "zh-CN" : "en-GB")}</small>}
    </span>
    {draft.pending && <span className="table-actions"><button type="button" onClick={draft.restore}>{zh ? "恢复草稿" : "Restore draft"}</button><button type="button" onClick={draft.clear}>{zh ? "丢弃草稿" : "Discard draft"}</button></span>}
    {hasFileUploads && <small>{zh ? "未完成上传的文件不能恢复，需重新选择。" : "Unfinished file uploads must be selected again."}</small>}
  </div>;
}
