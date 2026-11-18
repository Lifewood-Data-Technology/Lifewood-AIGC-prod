"use client";
import { useEffect, useRef, useState } from "react";
import { workspaceFetch as fetch } from "../lib/tab-session";
type MfaState = { enabled: boolean; configured: boolean; recoveryRemaining: number };
type MfaResult = { code?: string; secret?: string; recoveryCodes?: string[] };

export default function MfaSettings({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh";
  const [status, setStatus] = useState<MfaState | null>(null);
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [unknown, setUnknown] = useState(false);
  const submitting = useRef(false);
  async function refresh() {
    try {
      const response = await fetch("/api/mfa", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (response.status === 401 || response.status === 403) {
        setSecret(""); setRecovery([]); setPassword(""); setCode(""); setStatus(null); setUnknown(true);
      }
      if (!response.ok) throw new Error();
      const current = await response.json() as MfaState;
      setStatus(current); if (current.enabled) setSecret(""); else setRecovery([]);
      setUnknown(false); setError("");
    } catch { setError(zh ? "无法读取双重验证状态，请重试。" : "Could not read MFA status. Retry."); }
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/mfa", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const body = await response.json() as MfaState; if (!controller.signal.aborted) setStatus(body);
    }).catch(() => { if (!controller.signal.aborted) setError(zh ? "无法读取双重验证状态，请重试。" : "Could not read MFA status. Retry."); });
    return () => controller.abort();
  }, [zh]);
  async function change(action: string) {
    if (submitting.current || unknown) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/mfa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, password, code }), signal: AbortSignal.timeout(15000) });
      const body = await response.json() as MfaResult;
      if (!response.ok) {
        setError(response.status === 429 ? (zh ? "尝试过多，请 15 分钟后重试。" : "Too many attempts. Retry in 15 minutes.") : body.code === "MFA_INVALID" ? (zh ? "验证码无效、过期或已使用，请使用下一组动态码或未用过的恢复码。" : "Code invalid, expired or already used. Use the next authenticator code or an unused recovery code.") : body.code === "PASSWORD_INCORRECT" ? (zh ? "当前密码不正确。" : "Current password is incorrect.") : (zh ? "未完成操作，请刷新状态后检查；绑定已过期时需重新开始。" : "Action not completed. Refresh status; restart if enrollment expired."));
        if (response.status >= 500) setUnknown(true);
        return;
      }
      setCode(""); setConfirmed(false);
      if (body.secret) setSecret(body.secret);
      else { setSecret(""); setPassword(""); }
      if (body.recoveryCodes) setRecovery(body.recoveryCodes);
      else if (action === "disable") setRecovery([]);
      await refresh();
    } catch { setUnknown(true); setError(zh ? "结果未确认，请先刷新状态，不要重复提交。若已启用但未收到恢复码，可用下一组动态码重新生成。" : "Result unconfirmed. Refresh status before retrying. If enabled but recovery codes were not received, regenerate using the next authenticator code."); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <section className="panel mfa-panel" aria-label={zh ? "管理员双重验证" : "Administrator two-factor authentication"}>
    <header className="panel-head"><h2>{zh ? "管理员双重验证" : "Administrator two-factor authentication"}</h2><button type="button" className="secondary-button" disabled={busy} onClick={refresh}>{zh ? "刷新状态" : "Refresh status"}</button></header>
    <div className="mfa-content">
      <p className="admin-mfa-status">{status ? status.enabled ? (zh ? `已启用 · 剩余 ${status.recoveryRemaining} 个恢复码` : `Enabled · ${status.recoveryRemaining} recovery codes remaining`) : (zh ? "尚未启用，需由管理员本人绑定。" : "Not enabled. The administrator must enroll personally.") : (zh ? "读取状态中…" : "Loading status…")}</p>
      {status && !status.configured && <p>{zh ? "服务器尚未配置独立的双重验证加密密钥，暂不能绑定。请先由站点维护人员配置；不要把密钥填入此页面。" : "A separate MFA encryption key is not configured on the server. Ask the site maintainer to configure it before enrollment; do not enter it here."}</p>}
      {recovery.length > 0 && <div className="mfa-recovery" role="status">
        <strong>{zh ? "请立即安全保存恢复码，每个只能使用一次。离开此页后不再显示，请勿发给他人。" : "Save these recovery codes securely now. Each works once. They disappear when you leave this page. Do not share them."}</strong>
        <pre>{recovery.join("\n")}</pre>
        <button type="button" className="ghost-button" onClick={() => setRecovery([])}>{zh ? "我已保存，隐藏恢复码" : "Saved — hide recovery codes"}</button>
      </div>}
      {status && (status.configured || status.enabled) && <form onSubmit={event => event.preventDefault()} autoComplete="off">
        <label>{zh ? "当前登录密码" : "Current password"}<input type="password" value={password} maxLength={1024} autoComplete="current-password" onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
        {secret && <div className="mfa-secret"><p>{zh ? "在手机验证器选择“手动添加”：账号为此管理员，类型选择“基于时间”，输入下方密钥，再填写生成的 6 位动态码完成绑定。绑定有效期为 10 分钟。" : "In your authenticator choose manual entry: this administrator account, time-based, using the key below. Enter its six-digit code to finish within 10 minutes."}</p><code>{secret}</code></div>}
        {(secret || status.enabled) && <label>{zh ? "动态码或一次性恢复码" : "Authenticator or recovery code"}<input value={code} autoComplete="one-time-code" maxLength={64} onChange={event => setCode(event.target.value)} disabled={busy} /></label>}
        {status.enabled && <label className="mfa-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />{zh ? "我确认修改自己的验证方式；重新生成后旧恢复码失效。" : "I confirm changes to my authentication. Regenerating invalidates old recovery codes."}</label>}
        <div className="mfa-actions">
          {!status.enabled && <button type="button" className="primary-button" disabled={busy || unknown || !password || !status.configured || Boolean(secret && !code)} onClick={() => change(secret ? "confirm" : "start")}>{secret ? (zh ? "验证并启用" : "Verify and enable") : (zh ? "开始绑定验证器" : "Set up authenticator")}</button>}
          {secret && <button type="button" className="ghost-button" disabled={busy || unknown} onClick={() => { setSecret(""); setCode(""); }}>{zh ? "重新开始" : "Restart"}</button>}
          {status.enabled && <><button type="button" className="ghost-button" disabled={busy || unknown || !confirmed || !password || !code} onClick={() => change("recovery")}>{zh ? "重新生成恢复码" : "Regenerate recovery codes"}</button><button type="button" className="danger-button" disabled={busy || unknown || !confirmed || !password || !code} onClick={() => change("disable")}>{zh ? "停用双重验证" : "Disable two-factor authentication"}</button></>}
        </div>
      </form>}
      {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
