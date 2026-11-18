"use client";
import { useEffect, useRef, type ReactNode } from "react";
import DialogSections from "./DialogSections";
export default function SettingsReviewDialog({ label, busy, close, children }: { label: string; busy: boolean; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={ref} className="account-access-dialog compact-account-modal" aria-label={label} onCancel={event => { event.preventDefault(); if (!busy) close(); }}><DialogSections>{children}</DialogSections></dialog>;
}
