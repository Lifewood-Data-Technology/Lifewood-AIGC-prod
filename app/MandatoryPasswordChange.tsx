"use client";
import { workspaceFetch as fetch } from "../lib/tab-session";

import { useState, type FormEvent } from "react";

/** Does not mount the workspace or request any business data before rotation. */
export default function MandatoryPasswordChange({ locale, onExit }: { locale: "zh" | "en"; onExit: (changed: boolean) => void }) {
  const zh = locale === "zh";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    if (newPassword !== form.get("confirmPassword")) { setError(zh ? "两次输入的新密码不一致。" : "The passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/session", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error || (zh ? "修改失败，请重试。" : "Could not update password.")); return; }
      onExit(true);
    } catch { setError(zh ? "连接失败，请重试。" : "Connection failed. Please retry."); }
    finally { setBusy(false); }
  };
  return <main className="mandatory-password-page">
    <form className="modal-card" onSubmit={submit}>
      <header><h1>{zh ? "首次登录，请修改密码" : "Change your temporary password"}</h1><p>{zh ? "修改后才能进入工作台。请使用至少 12 位、含大小写字母、数字和符号的新密码。" : "Update your password before entering the workbench. Use at least 12 characters with uppercase, lowercase, numbers and symbols."}</p></header>
      <div className="modal-body">
        <label>{zh ? "当前／临时密码" : "Current / temporary password"}<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <label>{zh ? "新密码" : "New password"}<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></label>
        <label>{zh ? "确认新密码" : "Confirm new password"}<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></label>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="secondary-button" onClick={() => onExit(false)} disabled={busy}>{zh ? "退出登录" : "Sign out"}</button><button type="submit" className="primary-button" disabled={busy}>{busy ? (zh ? "保存中…" : "Saving…") : (zh ? "保存并重新登录" : "Save and sign in again")}</button></footer>
    </form>
  </main>;
}
