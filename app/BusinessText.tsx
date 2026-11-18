"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { businessContents, contentChunks, validContentTranslation } from "../lib/business-content";
type Entry = { source: string; en?: string; status: string };
type State = { locale: "zh" | "en"; eligible: Set<string>; entries: Map<string, Entry>; request: (value: string) => void; retry: (value: string) => void };
const Context = createContext<State | null>(null);

export function useBusinessLocale():"zh"|"en" {
  const context=useContext(Context);if(context)return context.locale;
  try{const saved=window.localStorage.getItem('lifewood-locale');if(saved==='zh'||saved==='en')return saved;}catch{/* Browser preference is optional. */}
  return typeof document!=='undefined'&&document.documentElement.lang.startsWith('en')?'en':'zh';
}

export function BusinessTextProvider({ source, locale, children }: { source: Record<string, unknown>; locale: "zh" | "en"; children: ReactNode }) {
  const eligible = useMemo(() => businessContents(source), [source]);
  const [entries, setEntries] = useState(new Map<string, Entry>());
  const [queue, setQueue] = useState<string[]>([]);
  const attempted = useRef(new Set<string>());
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const request = useCallback((value: string) => setQueue(previous => previous.includes(value) ? previous : [...previous, value]), []);
  const retry = useCallback((value: string) => { attempted.current.delete(value); setEntries(previous => { const next = new Map(previous); next.delete(value); return next; }); request(value); }, [request]);
  useEffect(() => {
    if (locale !== "en" || running.current) return;
    let size = 0;
    const batch = queue.filter(value => eligible.has(value) && !attempted.current.has(value)).filter(value => { size += value.length; return size <= 12000; }).slice(0, 4);
    if (!batch.length) return;
    batch.forEach(value => attempted.current.add(value));
    running.current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    // Even without an AI key, the server may have a previously cached translation.
    void workspaceFetch("/api/content-translations", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: batch }) })
      .then(async response => {
        if (!response.ok) throw new Error();
        const result = await response.json() as { translations: Entry[] };
        if (!alive.current) return;
        setEntries(previous => {
          const next = new Map(previous);
          for (const source of batch) next.set(source, { source, status: "failed" });
          for (const item of result.translations || []) {
            if (!batch.includes(item.source)) continue;
            try { next.set(item.source, { ...item, en: validContentTranslation(item.en) }); }
            catch { next.set(item.source, { source: item.source, status: "failed" }); }
          }
          return next;
        });
      }).catch(() => {
        if (alive.current) setEntries(previous => new Map([...previous, ...batch.map(source => [source, { source, status: "failed" }] as const)]));
      }).finally(() => { clearTimeout(timeout); running.current = false; if (alive.current) setQueue(previous => previous.filter(value => !batch.includes(value))); });
  }, [queue, eligible, locale]);
  return <Context.Provider value={{ locale, eligible, entries, request, retry }}>{children}</Context.Provider>;
}

export default function BusinessText({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const text = String(value ?? "");
  const context = useContext(Context);
  const [original, setOriginal] = useState(false);
  const eligible = context?.locale === "en" && context.eligible.has(text);
  const request = context?.request;
  useEffect(() => { if (eligible && text.length <= 3000) request?.(text); }, [eligible, request, text]);
  if (!eligible || !context) return <>{text}</>;
  if (text.length > 3000) return <>{contentChunks(text).map((part, index) => <BusinessText key={index} value={part} compact={compact} />)}</>;
  const entry = context.entries.get(text);
  if (compact) return <span className="business-translation" title={entry?.en ? `Original: ${text}` : undefined}>{entry?.en || text}{!entry?.en && <small>{entry?.status === "failed" ? "Translation unavailable · original shown" : "Translating · original shown"}</small>}</span>;
  return <span className="business-translation">
    <span>{entry?.en && !original ? entry.en : text}</span>
    {entry?.en ? <button type="button" className="business-original-toggle" title="Automatic English translation; check the original for important details" aria-expanded={original} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} onClick={event => { event.stopPropagation(); setOriginal(value => !value); }}>{original ? "Show translation" : "View original"}</button>
      : <small role="status">{entry?.status === "failed" ? <>Translation unavailable · original shown <button type="button" className="business-original-toggle" onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} onClick={event => { event.stopPropagation(); context.retry(text); }}>Retry</button></> : "Translating · original shown"}</small>}
  </span>;
}
