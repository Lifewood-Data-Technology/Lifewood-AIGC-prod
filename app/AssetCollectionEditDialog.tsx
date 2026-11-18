"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import DialogSections from "./DialogSections";
import { DraftNotice, mayLeaveDrafts, useDraftOwner, useDraftRisk, useLocalDraft } from "./useLocalDraft";
import { requestWorkflow } from "../lib/workflow-client";
import { workspaceFetch } from "../lib/tab-session";

type Row = Record<string, unknown>;
type Values = { title: string; description: string; tags: string; revision: number; pending: Record<string, string> | null };
const tagsOf = (value: unknown): string[] => { try { const tags: unknown = JSON.parse(String(value || "[]")); return Array.isArray(tags) && tags.every(item => typeof item === "string") ? tags : []; } catch { return []; } };
const fields = (collection: Row): Values => ({ title: String(collection.title || ""), description: String(collection.description || ""), tags: tagsOf(collection.tags_json).join("\n"), revision: Number(collection.revision), pending: null });
const sanitize = (value: unknown): Values | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Values;
  if (![row.title, row.description, row.tags].every(item => typeof item === "string") || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.title.length > 80 || row.description.length > 4000 || row.tags.length > 2000) return null;
  if (row.pending && (typeof row.pending !== "object" || !Object.values(row.pending).every(item => typeof item === "string"))) return null;
  return row;
};

export default function AssetCollectionEditDialog({ collection, locale, close, saved }: { collection: Row; locale: "zh" | "en"; close: () => void; saved: () => void }) {
  const zh = locale === "zh", owner = useDraftOwner(), id = String(collection.id);
  const draft = useLocalDraft(owner ? `lifewood-form-draft:${owner}:asset-metadata:${id}` : "", fields(collection), sanitize);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [revoked, setRevoked] = useState(false), [complete, setComplete] = useState(false);
  const shell = useRef<HTMLElement>(null);
  const latch = useRef(false), alive = useRef(true), authority = useRef({ owner, id });
  useLayoutEffect(() => { authority.current = { owner, id }; }, [owner, id]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useDraftRisk(busy || Boolean(draft.value.pending));
  useEffect(() => {
    const node = shell.current;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && node?.contains(event.target as Node)) {
        event.preventDefault();
        if (!busy && mayLeaveDrafts(locale)) close();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, locale, close]);
  const attemptClose = () => { if (!busy && mayLeaveDrafts(locale)) close(); };
  const pending = draft.value.pending, tags = [...new Set(draft.value.tags.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  const stale = !pending && draft.value.revision !== Number(collection.revision);
  const valid = Boolean(draft.value.title.trim()) && draft.value.title.trim().length <= 80 && !/[\\/:*?"<>|]/.test(draft.value.title) && ![".", ".."].includes(draft.value.title.trim()) && draft.value.description.length <= 4000 && tags.length <= 20 && tags.every(value => value.length <= 80);
  const frozen = busy || Boolean(pending) || Boolean(draft.pending) || revoked || complete;
  const uncertain = zh ? "保存结果待核对，请保留草稿，使用同一次内容核对。" : "Save result is unconfirmed. Keep this draft and check the same submission.";
  const submit = async () => {
    if (latch.current || revoked || complete || draft.pending || stale || (!pending && !valid)) return;
    latch.current = true; setBusy(true); setError("");
    const started = { owner, id }, original = draft.value;
    const payload = pending || { collectionId: id, expectedRevision: String(original.revision), title: original.title.trim(), description: original.description.trim(), tags: JSON.stringify(tags) };
    if (payload.collectionId !== id || Number(payload.expectedRevision) !== original.revision) {
      setError(uncertain); latch.current = false; setBusy(false); return;
    }
    draft.setValue({ ...original, pending: payload });
    const current = () => alive.current && authority.current.owner === started.owner && authority.current.id === started.id;
    try {
      const { response, body } = await requestWorkflow<Row>("asset.collection.update", payload);
      if (!current()) return;
      if (response.status === 202 || response.status >= 500) throw Error("UNCONFIRMED");
      let confirmed = response.ok && !body.error && body.ok === true && body.collectionId === payload.collectionId && body.revision === Number(payload.expectedRevision) + 1;
      if (!response.ok && response.status === 409 && pending) {
        // A lost response followed by the same revision may mean the first write succeeded.
        // Read through the existing authorized platform endpoint before confirming anything.
        const check = await workspaceFetch("/api/platform", { cache: "no-store", signal: AbortSignal.timeout(30000) });
        const platform: unknown = await check.json();
        if (!current()) return;
        if (!check.ok || !platform || typeof platform !== "object" || !Array.isArray((platform as Row).assetCollections)) throw Error("UNCONFIRMED");
        const found = ((platform as Row).assetCollections as Row[]).find(item => item.id === payload.collectionId);
        if (!found) { setRevoked(true); setError(zh ? "集合不存在或访问权限已变化。" : "Collection unavailable or access changed."); return; }
        confirmed = Number(found.revision) === Number(payload.expectedRevision) + 1 && found.title === payload.title && found.description === payload.description && JSON.stringify(tagsOf(found.tags_json)) === payload.tags;
        if (!confirmed) throw Error("UNCONFIRMED");
      }
      if (!response.ok && !confirmed) {
        if (response.status === 403 || response.status === 401) setRevoked(true);
        draft.setValue({ ...original, pending: null });
        setError(zh ? (response.status === 409 ? "集合已变化，请关闭后刷新并重新编辑；当前草稿已保留。" : "保存被拒绝，请检查权限和填写内容。") : (response.status === 409 ? "Collection changed. Close, refresh and review this saved draft." : "Save rejected. Check your access and fields."));
        return;
      }
      if (!confirmed) throw Error("UNCONFIRMED");
      setComplete(true); draft.clear();
      try { saved(); } catch { setError(zh ? "修改已保存，但列表刷新失败，请重新刷新。" : "Changes saved, but the list could not refresh. Refresh again."); }
    } catch { if (current()) setError(uncertain); }
    finally { latch.current = false; if (current()) setBusy(false); }
  };
  return <div className="modal-backdrop asset-create-backdrop"><section ref={shell} className="modal-card asset-create-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-metadata-title"><DialogSections>
    <header><h2 id="asset-metadata-title">{zh ? "编辑成片资料" : "Edit collection details"}</h2><button type="button" className="close-button" aria-label={zh ? "关闭" : "Close"} disabled={busy} onClick={attemptClose}>×</button></header>
    {revoked ? <p role="alert">{zh ? "集合不存在或暂无维护权限。" : "Collection unavailable or maintenance access revoked."}</p> : <div className="asset-create-body">
      <DraftNotice draft={{ ...draft, clear: () => { if (pending || draft.pending?.value.pending) { setError(uncertain); return; } draft.clear(); } }} locale={locale} hasFileUploads={false}/>
      <div className="asset-create-fields"><label className="wide"><span>{zh ? "成片名称" : "Collection name"}</span><input value={draft.value.title} maxLength={80} required disabled={frozen} onChange={event => draft.setValue({ ...draft.value, title: event.target.value })}/></label>
      <label className="wide"><span>{zh ? "说明" : "Description"}</span><textarea value={draft.value.description} maxLength={4000} rows={4} disabled={frozen} onChange={event => draft.setValue({ ...draft.value, description: event.target.value })}/></label>
      <label className="wide"><span>{zh ? "标签（每行一个，最多 20 个）" : "Tags (one per line, up to 20)"}</span><textarea value={draft.value.tags} maxLength={2000} rows={3} disabled={frozen} onChange={event => draft.setValue({ ...draft.value, tags: event.target.value })}/></label></div>
      {stale && <p role="alert">{zh ? "集合已更新，请关闭后刷新并核对草稿。" : "The collection was updated. Close, refresh and review your draft."}</p>}
      {error && <p role="alert">{error}</p>}
      {complete && <p role="status">{zh ? "修改已保存。" : "Changes saved."}</p>}
    </div>}
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={attemptClose}>{zh ? "取消" : "Cancel"}</button><button type="button" className="primary-button" disabled={busy || revoked || complete || Boolean(draft.pending) || stale || (!pending && !valid)} onClick={() => void submit()}>{busy ? (zh ? "保存中…" : "Saving…") : pending ? (zh ? "核对保存结果" : "Check saved result") : (zh ? "保存修改" : "Save changes")}</button></footer>
  </DialogSections></section></div>;
}
