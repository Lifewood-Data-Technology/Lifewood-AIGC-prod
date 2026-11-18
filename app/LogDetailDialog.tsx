"use client";
import { useEffect, useRef, type ReactNode } from "react";
import DialogSections from "./DialogSections";

/** A compact native dialog: the browser owns trapping; only its body scrolls. */
export default function LogDetailDialog({ title, close, children, footer, busy = false, locale, returnFocus }: {
  title: string; locale: "zh" | "en"; close: () => void; children: ReactNode; footer?: ReactNode; busy?: boolean; returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement, node = ref.current;
    node?.showModal();
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [returnFocus]);
  return <dialog ref={ref} className="admin-log-dialog" aria-label={title} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) close(); }}><DialogSections>
    <header><h2>{title}</h2><button type="button" className="log-icon-button" aria-label={locale === "en" ? "Close dialog" : "关闭弹窗"} title={locale === "en" ? "Close dialog" : "关闭弹窗"} disabled={busy} onClick={close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
    {children}
    <footer>{footer ?? <button type="button" className="secondary-button" onClick={close}>{locale === "en" ? "Close" : "关闭"}</button>}</footer>
  </DialogSections></dialog>;
}

export function LogDetailFields({ fields, missing }: { fields: [string, ReactNode][]; missing: string }) {
  return <dl className="log-detail-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value == null || value === "" ? missing : value}</dd></div>)}</dl>;
}
