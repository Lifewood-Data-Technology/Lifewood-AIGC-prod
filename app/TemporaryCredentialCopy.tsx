"use client";

import { type ReactNode, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";

export default function TemporaryCredentialCopy({ email, password, locale, passwordVisible, passwordToggle, temporary = true }: {
  email: string;
  password: string;
  locale: "zh" | "en";
  temporary?: boolean;
  passwordVisible: boolean;
  passwordToggle: ReactNode;
}) {
  const active = useRef(false);
  const [pending, setPending] = useState<"email" | "password" | null>(null);
  const [result, setResult] = useState<"email" | "password" | "error" | null>(null);
  const zh = locale === "zh";
  const passwordLabel = temporary ? (zh ? "临时密码" : "Temporary password") : (zh ? "新密码" : "New password");

  async function copy(field: "email" | "password") {
    if (active.current) return;
    active.current = true;
    setPending(field);
    setResult(null);
    try {
      await copyText(field === "email" ? email : password);
      setResult(field);
    } catch {
      setResult("error");
    } finally {
      active.current = false;
      setPending(null);
    }
  }

  function copyButton(field: "email" | "password") {
    const copied = result === field;
    const label = field === "email" ? (zh ? "复制账号" : "Copy account") : (zh ? `复制${passwordLabel}` : `Copy ${passwordLabel.toLowerCase()}`);
    return <button type="button" className="credential-copy-button" aria-label={label} disabled={pending !== null} data-copied={copied} onClick={() => void copy(field)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
      </svg>
      <span>{pending === field ? (zh ? "复制中…" : "Copying…") : copied ? (zh ? "已复制" : "Copied") : field === "email" ? (zh ? "复制账号" : "Copy account") : (zh ? "复制密码" : "Copy password")}</span>
    </button>;
  }

  return <div className="temporary-credential" data-locale={locale}>
    <div className="credential-field">
      <span className="credential-field-label">{zh ? "邮箱账号" : "Email account"}</span>
      <div className="credential-value-row">
        <strong className="credential-email">{email}</strong>
        {copyButton("email")}
      </div>
    </div>
    <div className="credential-field">
      <span className="credential-field-label">{passwordLabel}</span>
      <div className="credential-value-row temporary-password-row">
        <code>{passwordVisible ? password : "••••••••••••••••"}</code>
        {passwordToggle}
        {copyButton("password")}
      </div>
    </div>
    <div className="credential-feedback-slot">
      {result ? <div className="credential-copy-feedback" data-tone={result === "error" ? "error" : "success"} role={result === "error" ? "alert" : "status"}>
        <span className="credential-feedback-icon" aria-hidden="true">{result === "error" ? "!" : "✓"}</span>
        <span>{result === "error" ? (zh ? "复制失败，请重试或手动选择复制。" : "Copy failed. Retry or select and copy manually.")
          : result === "email" ? (zh ? "账号已复制，可以粘贴使用。" : "Account copied. Ready to paste.")
            : (zh ? `${passwordLabel}已复制，可以粘贴使用。` : `${passwordLabel} copied. Ready to paste.`)}</span>
      </div> : <p className="credential-copy-hint" role={pending ? "status" : undefined}>{pending ? (zh ? "正在复制…" : "Copying…") : (zh ? "账号和密码可分别复制；复制密码无需先显示。" : "Copy each field separately. The password can stay hidden.")}</p>}
    </div>
  </div>;
}
