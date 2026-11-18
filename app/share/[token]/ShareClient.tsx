"use client";
import {FileVideo} from "../../DirectFileMedia";
import {BusinessTextProvider} from "../../BusinessText";

import { useEffect, useState } from "react";

type Share = { locked: boolean; kind?: string; projectName?: string; clientName?: string; language?: string; originalName?: string; sizeBytes?: number; expiresAt?: string };

export default function ShareClient({ token }: { token: string }) {
  const [locale, setLocale] = useState<"zh" | "en">("zh");
  const [share, setShare] = useState<Share | null>(null);
  const [password, setPassword] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unlockError, setUnlockError] = useState("");
  const load = async (value = "") => {
    setLoading(true); setInvalid(false); setUnlockError("");
    try {
    const unlock = await fetch("/api/shares/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: value }), cache: "no-store" });
    if (!unlock.ok) {
      setUnlockError(unlock.status === 429
        ? (locale === "zh" ? "尝试过多，请等待 15 分钟后重试。" : "Too many attempts. Wait 15 minutes before retrying.")
        : (locale === "zh" ? "链接或密码无效，请检查后重试。" : "Invalid link or password. Check and retry."));
      setLoading(false); return;
    }
    const response = await fetch(`/api/shares?token=${encodeURIComponent(token)}`, { cache: "no-store" });
    const body = await response.json() as Share & { error?: string };
    if (!response.ok) { setInvalid(true); setShare(null); } else setShare(body);
    setLoading(false);
    } catch { setUnlockError(locale === "zh" ? "网络暂不可用，请稍后重试。" : "Network unavailable. Please retry."); setLoading(false); }
  };
  useEffect(() => {
    let current = true;
    fetch(`/api/shares?token=${encodeURIComponent(token)}`).then(async (response) => {
      const body = await response.json() as Share & { error?: string };
      if (!current) return;
      if (!response.ok) { setInvalid(true); setShare(null); } else setShare(body);
      setLoading(false);
    }).catch(() => { if (current) { setInvalid(true); setLoading(false); } });
    return () => { current = false; };
  }, [token]);
  const zh = locale === "zh";
  return <BusinessTextProvider source={{}} locale={locale}><main className="public-share"><header><div><span className="mark"><span /></span><span>Lifewood <b>AIGC</b></span></div><button onClick={() => setLocale(zh ? "en" : "zh")}>{zh ? "EN" : "中文"}</button></header><section className="share-stage">{loading ? <div className="share-message"><span className="share-loader" /><h1>{zh ? "正在验证链接" : "Checking link"}</h1></div> : invalid ? <div className="share-message"><span className="share-error">×</span><h1>{zh ? "链接或密码无效" : "This link or password is invalid"}</h1><p>{zh ? "请检查访问密码，或联系项目联系人获取新链接。" : "Check the password or contact your project representative for a new link."}</p></div> : share?.locked ? <form className="share-message" onSubmit={(event) => { event.preventDefault(); load(password); }}><span className="share-lock">⌁</span><h1>{zh ? "请输入访问密码" : "Enter access password"}</h1>{unlockError && <p role="alert">{unlockError}</p>}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={128} required /><button>{zh ? "继续" : "Continue"}</button></form> : share ? <div className="share-content"><div className="share-heading"><span>{share.clientName}</span><h1>{share.projectName}</h1><p>{share.language} · {share.originalName}</p></div><div className="share-video">{share.kind === "preview" ? <FileVideo controls controlsList="nodownload" src={`/api/public-file?token=${encodeURIComponent(token)}`}><track kind="captions" src="data:text/vtt,WEBVTT" srcLang={zh ? "zh" : "en"} label={zh ? "字幕" : "Captions"} /></FileVideo> : <div className="download-card"><span>↓</span><strong>{share.originalName}</strong><p>{zh ? "此交付链接允许下载已确认成品。" : "This delivery link allows the confirmed final to be downloaded."}</p><a href={`/api/public-file?token=${encodeURIComponent(token)}`}>{zh ? "下载成品" : "Download final"}</a></div>}</div><footer><span>{zh ? "链接失效时间" : "Link expires"}: {share.expiresAt ? new Intl.DateTimeFormat(zh ? "zh-CN" : "en-GB", { dateStyle: "medium" }).format(new Date(share.expiresAt)) : "—"}</span><span>{zh ? "由 Lifewood AIGC 安全分享" : "Securely shared by Lifewood AIGC"}</span></footer></div> : null}</section></main></BusinessTextProvider>;
}
