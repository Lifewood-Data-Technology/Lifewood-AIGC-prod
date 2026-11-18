"use client";
import DialogSections from "./DialogSections";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { workspaceFetch as fetch } from "../lib/tab-session";
import { applyNameTranslation, businessTitle, hasChinese, nameFields, nameNeedsTranslation, originalBusinessName, type BusinessNameKind } from "../lib/business-locale";

type Row = Record<string, unknown>;
type Kind = BusinessNameKind;
type Target = { kind: Kind; row: Row };
const str = (value: unknown) => String(value ?? "");
export default function NameTranslations({ projects, videos, requests, clients = [], translations, locale, canEdit, configured, onMerge }: {
  projects: Row[]; videos: Row[]; requests: Row[]; clients?: Row[]; translations: Row[];
  locale: "zh" | "en"; canEdit: boolean; configured: boolean; onMerge: (rows: Row[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Target | null>(null);
  const [zh, setZh] = useState("");
  const [en, setEn] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [automaticPaused, setAutomaticPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const attempted = useRef(new Set<string>());
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const targets: Target[] = ([
    ...projects.map(row => ({ kind: "project" as const, row })),
    ...videos.map(row => ({ kind: "video" as const, row })),
    ...requests.map(row => ({ kind: "request" as const, row })),
    ...clients.flatMap(row => (["client", "client_legal", "contact"] as const).map(kind => ({ kind, row }))),
  ]).filter(({ kind, row }) => hasChinese(originalBusinessName(row, kind)));
  // One request at a time, once per original name per mount. Failures keep the
  // original visible and never block navigation or business work.
  useEffect(() => {
    if (!configured || automaticPaused || running.current) return;
    const target = targets.find(({ kind, row }) => {
      const source = originalBusinessName(row, kind);
      return locale === "en" && nameNeedsTranslation(applyNameTranslation(row, kind, translations), kind) &&
        !attempted.current.has(`${kind}:${row.id}:${source}`);
    });
    if (!target) return;
    const { kind, row } = target;
    attempted.current.add(`${kind}:${row.id}:${originalBusinessName(row, kind)}`);
    running.current = true;
    setWorking(true);
    void fetch("/api/name-translations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ kind, id: row.id }] }) })
      .then(async response => {
        if (!response.ok) { if (mounted.current) setAutomaticPaused(true); return; }
        const result = await response.json() as { translations?: Row[] };
        if (mounted.current && result.translations) {
          onMerge(result.translations);
          if (result.translations.some(row => row.status === "failed")) setAutomaticPaused(true);
        }
      }).catch(() => { if (mounted.current) setAutomaticPaused(true); }).finally(() => {
        running.current = false;
        if (mounted.current) { setWorking(false); setRevision(v => v + 1); }
      });
  // Arrays come from the latest permission-scoped platform snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, videos, requests, clients, translations, locale, configured, automaticPaused, onMerge, revision]);
  const choose = (target: Target) => {
    const localized = applyNameTranslation(target.row, target.kind, translations);
    setSelected(target); setZh(businessTitle(localized, "zh", target.kind));
    setEn(businessTitle(localized, "en", target.kind)); setMessage("");
  };
  const save = async () => {
    if (!selected) return;
    const { kind, row } = selected;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/name-translations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ kind, id: row.id, source: originalBusinessName(row, kind), baseZh: str(row[nameFields(kind).zh]), baseEn: str(row[nameFields(kind).en]), zh, en }] }) });
      const result = await response.json() as { translations?: Row[] };
      if (!response.ok || !result.translations?.some(row => row.status === "confirmed")) throw new Error();
      onMerge(result.translations); setMessage(locale === "zh" ? "译名已确认，原始名称保留。" : "Translation confirmed. The original name is retained.");
    } catch { setMessage(locale === "zh" ? "保存失败，请检查中英文名称（各不超过80字，不含路径符号），或刷新后重试。" : "Could not save. Check both names (80 characters max, no path symbols), or refresh and retry."); }
    finally { setSaving(false); }
  };
  if (!targets.length) return null;
  return <>
    {working ? <small role="status">{locale === "zh" ? "正在生成译名…" : "Translating names…"}</small> : null}
    {automaticPaused ? <small role="status">{locale === "zh" ? "部分译名未生成，暂用原文" : "Some names use the original; translation unavailable"}</small> : null}
    {canEdit ? <button onClick={() => setOpen(true)}>{locale === "zh" ? "核对译名" : "Review names"}</button> : null}
    {open && canEdit ? createPortal(<div className="modal-backdrop"><section className="modal-card name-review-dialog" role="dialog" aria-modal="true" aria-labelledby="name-review-title"><DialogSections>
      <header><h2 id="name-review-title">{locale === "zh" ? "中英文名称核对" : "Review bilingual names"}</h2><button onClick={() => setOpen(false)} aria-label={locale === "zh" ? "关闭" : "Close"}>×</button></header>
      <p>{locale === "zh" ? "仅为中文原名生成英文展示名，原本为英文的名称不反向翻译。联系人使用姓名拼音；品牌译名和姓名读音请人工核对。未生成译名时暂用原文。" : "Only Chinese originals get English display names. English originals stay unchanged. Contacts use Pinyin; review brand names and pronunciation. Missing translations use the original."}</p>
      <input aria-label={locale === "zh" ? "搜索名称" : "Search names"} placeholder={locale === "zh" ? "搜索客户、联系人、项目、视频或需求" : "Search customers, contacts, projects, videos or briefs"} value={query} onChange={e => setQuery(e.target.value)} />
      <small>{locale === "zh" ? "最多显示30项，请搜索定位其他名称。" : "Up to 30 matches shown. Search to find more names."}</small>
      {automaticPaused && configured ? <button onClick={() => { attempted.current.clear(); setAutomaticPaused(false); }}>{locale === "zh" ? "重试自动翻译" : "Retry translation"}</button> : null}
      <div className="name-review-list">{targets.filter(({ kind, row }) => JSON.stringify(applyNameTranslation(row, kind, translations)).toLowerCase().includes(query.toLowerCase())).slice(0, 30).map(target => {
        const row = applyNameTranslation(target.row, target.kind, translations);
        const kindLabels: Record<Kind, [string, string]> = { project: ["项目", "Project"], video: ["视频", "Video"], request: ["需求", "Brief"], client: ["客户", "Customer"], client_legal: ["客户公司全称", "Legal company name"], contact: ["客户联系人", "Customer contact"] };
        return <button key={`${target.kind}:${row.id}`} onClick={() => choose(target)}><strong>{businessTitle(row, locale, target.kind)}</strong><small>{kindLabels[target.kind][locale === "zh" ? 0 : 1]} · {row.translation_status === "confirmed" ? (locale === "zh" ? "已确认" : "Confirmed") : (locale === "zh" ? "待核对" : "Needs review")}</small></button>;
      })}</div>
      {selected ? <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <p>{locale === "zh" ? "原始名称：" : "Original: "}{originalBusinessName(selected.row, selected.kind)}</p>
        <label>{locale === "zh" ? "中文原名（保留）" : "Chinese original (retained)"}<input value={zh} readOnly /></label>
        <label>English<input value={en} maxLength={80} required onChange={e => setEn(e.target.value)} /></label>
        <button className="primary-button" disabled={saving}>{saving ? (locale === "zh" ? "保存中…" : "Saving…") : (locale === "zh" ? "确认译名" : "Confirm translation")}</button>
      </form> : null}
      <p role="status">{message}</p>
    </DialogSections></section></div>, document.querySelector(".app-shell") || document.body) : null}
  </>;
}
