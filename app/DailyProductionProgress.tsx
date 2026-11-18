"use client";
import { useState } from "react";
import { requestWorkflow } from "../lib/workflow-client";
import { progressEditableStatuses, validProductionProgress } from "../lib/task-file-access";
import { languageLabel } from "../lib/business-locale";
import BusinessText from "./BusinessText";
type Row = Record<string, unknown>;
type Locale = "zh" | "en";

export function ReportedTaskProgress({ task, locale }: { task: Row; locale: Locale }) {
  const zh = locale === "zh";
  const percent = Number(task.production_progress);
  const available = task.production_progress !== null && task.production_progress !== undefined && Boolean(task.production_progress_at) && Number.isInteger(percent) && percent >= 0 && percent <= 100;
  const updated = new Date(String(task.production_progress_at || ""));
  return <div className="reported-task-progress">
    <div><strong>{languageLabel(task.language_code, task.language, locale)}</strong><span>{zh ? "制作进度（剪辑师填报）" : "Production progress (editor reported)"}</span><b>{available ? `${percent}%` : zh ? "未填报" : "Not reported"}</b></div>
    {available && <>
      <progress max="100" value={percent} aria-label={`${languageLabel(task.language_code, task.language, locale)} ${zh ? "制作进度" : "production progress"}`} />
      <small>{String(task.production_progress_by === task.editor_email ? task.editor_name || task.production_progress_by : task.production_progress_by)} · {Number.isNaN(updated.getTime()) ? "—" : updated.toLocaleString(zh ? "zh-CN" : "en-GB", { timeZone: "Asia/Shanghai" })} {zh ? "（上海时间）" : "(Shanghai)"}</small>
      {Boolean(task.production_progress_note) && <p><BusinessText value={String(task.production_progress_note)} /></p>}
    </>}
  </div>;
}

export default function DailyProductionProgress({ language, locale, refresh }: { language: Row; locale: Locale; refresh: () => void }) {
  const zh = locale === "zh";
  const [percent, setPercent] = useState(String(language.production_progress ?? ""));
  const [note, setNote] = useState(String(language.production_progress_note || ""));
  const [savedTask, setSavedTask] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = savedTask && Number(savedTask.revision) > Number(language.revision) ? { ...language, ...savedTask } : language;
  const editable = progressEditableStatuses.includes(String(current.status));
  const save = async () => {
    if (busy || !editable || !validProductionProgress(percent)) return;
    setBusy(true); setMessage("");
    try {
      const { response, body } = await requestWorkflow<{ error?: string; task?: Row }>("production.progress.save", {
        languageProjectId: String(language.id), percent, note, expectedRevision: String(current.revision),
      });
      if (!response.ok || !body.task) throw new Error(body.error || "UNCONFIRMED");
      setSavedTask(body.task);
      setMessage(zh ? "制作进度已保存，检查点和质检状态未改变。" : "Progress saved. Checkpoints and review status are unchanged.");
      refresh();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessage(code === "PROGRESS_CONFLICT" || code === "PROGRESS_NOT_ALLOWED"
        ? zh ? "任务已更新或已转交，请刷新核对后再填写。输入内容已保留。" : "The task changed or was reassigned. Refresh and review it. Your input is retained."
        : code === "PROGRESS_INVALID" ? zh ? "进度须为 0–100 的整数，说明最多 1000 字。" : "Enter a whole number from 0 to 100 and a note of up to 1,000 characters."
        : zh ? "保存结果尚未确认，请先刷新核对。输入内容已保留，不会自动重复提交。" : "Save outcome is unconfirmed. Refresh to check. Input is retained; nothing is resubmitted automatically.");
    } finally { setBusy(false); }
  };
  return <section className="daily-production-progress" aria-label={zh ? "每日制作进度" : "Daily production progress"}>
    <h3>{zh ? "每日制作进度" : "Daily production progress"}</h3>
    <p>{zh ? "每天填写本视频、本语言的实际制作进度。100% 仅表示制作完成，不代表质检通过或已交付；原有检查点与成片上传方式不变。" : "Report progress for this video and language each day. 100% means production is complete, not quality approval or delivery. Checkpoint and final-upload workflows are unchanged."}</p>
    <ReportedTaskProgress task={current} locale={locale} />
    {editable ? <div className="daily-progress-inputs">
      <label>{zh ? "制作进度（%）" : "Production progress (%)"}<input type="number" min="0" max="100" step="1" value={percent} disabled={busy} onChange={event => setPercent(event.target.value)} /></label>
      <label>{zh ? "今日进展 / 剩余工作（选填）" : "Today's progress / remaining work (optional)"}<textarea maxLength={1000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
      <button type="button" className="primary-button" disabled={busy || !validProductionProgress(percent)} onClick={() => void save()}>{busy ? zh ? "保存中…" : "Saving…" : zh ? "保存制作进度" : "Save production progress"}</button>
    </div> : <p>{zh ? "当前任务不在制作阶段，已保留最后填报的进度。" : "This task is not in production. The last reported progress is retained."}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
