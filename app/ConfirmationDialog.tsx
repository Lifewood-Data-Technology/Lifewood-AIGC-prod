"use client";
import { useRef, useState } from "react";
import OperationDialog from "./OperationDialog";

export default function ConfirmationDialog({ title, message, confirmLabel, locale, close, confirm }: {
  title: string; message: string; confirmLabel: string; locale: "zh" | "en";
  close: () => void; confirm: () => Promise<boolean>;
}) {
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setFailed(false);
    try { if (await confirm()) close(); else setFailed(true); }
    catch { setFailed(true); }
    finally { sending.current = false; setBusy(false); }
  };
  return <OperationDialog compact title={title} locale={locale} onDismiss={()=>{if(!sending.current) close();}}>
    <p>{message}</p>
    {failed && <p role="alert">{locale === "zh" ? "操作未确认完成，请关闭并刷新核对，勿重复提交。" : "The outcome is unconfirmed. Close and refresh to verify before submitting again."}</p>}
    <footer>
      <button className="secondary-button" disabled={busy} onClick={close}>{locale === "zh" ? "取消" : "Cancel"}</button>
      <button className="primary-button" disabled={busy || failed} onClick={()=>void submit()}>{busy ? locale === "zh" ? "处理中…" : "Working…" : confirmLabel}</button>
    </footer>
  </OperationDialog>;
}
