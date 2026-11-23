"use client";
// Historical files and handover checks for the production team.
import { useId, useState } from "react";
import { filePreviewKind } from "../lib/request-security";
import type { DeseretArchiveFile, DeseretWorkspace } from "../lib/deseret-workspace";
import { MenuIcon } from "./MenuIcon";

type Command = (action: DeseretWorkspace["actions"][number], payload: Record<string, unknown>) => Promise<void>;
export default function DeseretArchivePanel({ data, taskId, locale, busy, command }: {
  data: DeseretWorkspace; taskId?: string; locale: "en" | "zh"; busy: boolean; command: Command;
}) {
  const zh = locale === "zh", t = (cn: string, en: string) => zh ? cn : en;
  const tasks = data.tasks.filter(task => !taskId || task.id === taskId);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const label = (id: string) => data.tasks.find(task => task.id === id)?.language ?? id;
  const can = (action: DeseretWorkspace["actions"][number]) => data.actions.includes(action);
  const kinds = { planned: t("计划交接", "Planned handover"), emergency: t("应急交接", "Emergency handover"), batch: t("负责人改派", "Reassigned by lead") };
  const verification = { pending: t("待核验", "Awaiting verification"), verified: t("已核验可续作", "Verified, work can continue"), missing: t("缺项", "Missing work reported") };
  const fileText = (file: { name: string; version: number; live: boolean }) => `${file.name} v${file.version}${file.live ? "" : t("（已失效）", " (no longer available)")}`;
  const panelId = useId();
  const fileLinks = (file: DeseretArchiveFile) => {
    const url = `/api/files?id=${encodeURIComponent(file.id)}&directOnly=1`;
    return <span key={file.id}>{fileText(file)} {file.live && <>
      <a href={`${url}&download=1`} aria-label={t(`下载 ${fileText(file)}`, `Download ${fileText(file)}`)}>{t("下载", "Download")}</a>
      {filePreviewKind(file.mimeType) && <> · <a href={url} target="_blank" rel="noopener noreferrer"
        aria-label={t(`预览 ${fileText(file)}`, `Preview ${fileText(file)}`)}>{t("预览", "Preview")}</a></>}
    </>}</span>;
  };
  const handovers = (data.handovers ?? []).filter(handover => !taskId || handover.taskId === taskId);
  const hasHistory = tasks.some(task => data.archives?.some(item => item.taskId === task.id)
    || data.handoverFiles?.some(file => file.taskId === task.id));
  if (!handovers.length && !hasHistory) return null;
  return (
    <section className="pm-detail-card deseret-archive" data-section="deseret-archive" aria-labelledby={panelId}>
      <header className="archive-heading">
        <h4 id={panelId}><MenuIcon name="projects" />{t("交接记录", "Handover history")}</h4>
        {tasks.length === 1 && <span>{tasks[0].language}</span>}
      </header>
      {handovers.map(handover => (
        <article key={handover.id} data-handover={handover.id}>
          <strong>{kinds[handover.kind]} · {label(handover.taskId)} · {verification[handover.verification]}</strong>
          <p>{handover.from} → {handover.to}{handover.archiveId ? <> · <a href={`#${panelId}-${handover.archiveId}`}>{t("留档", "Archive")} #{data.archives?.find(item => item.id === handover.archiveId)?.number ?? "?"}</a></> : ` · ${t("交接时无有效留档", "No valid archive at handover")}`}</p>
          {handover.notes && <p>{handover.notes}</p>}
          {handover.verification === "pending" && can("handover.verify") && (
            <div>
              <label>{t("核验说明（登记缺项时必填）", "Verification note (required for missing work)")}
                <textarea maxLength={4000} value={notes[handover.id] ?? ""} onChange={event => setNotes({ ...notes, [handover.id]: event.target.value })} />
              </label>
              <button type="button" disabled={busy} onClick={() => void command("handover.verify", { handoverId: handover.id, result: "verified", notes: (notes[handover.id] ?? "").trim() }).catch(() => {})}>
                {t("可以续作", "Verified, can continue")}
              </button>
              <button type="button" disabled={busy || !(notes[handover.id] ?? "").trim()} onClick={() => void command("handover.verify", { handoverId: handover.id, result: "missing", notes: (notes[handover.id] ?? "").trim() }).catch(() => {})}>
                {t("登记缺项", "Report missing work")}
              </button>
            </div>
          )}
        </article>
      ))}
      {tasks.map(task => {
        const workFiles = (data.handoverFiles ?? []).filter(file => file.taskId === task.id);
        const archives = (data.archives ?? []).filter(archive => archive.taskId === task.id);
        if (!workFiles.length && !archives.length) return null;
        return (
          <div key={task.id} className="archive-history">
            {tasks.length > 1 && <h5>{task.language}</h5>}
            {workFiles.length > 0 && <details>
              <summary>{t("接手任务的文件和共享素材", "Task files and shared materials")}</summary>
              <ul>{workFiles.map(file => <li key={file.id}>{fileLinks(file)}</li>)}</ul>
            </details>}
            {archives.map(archive => (
              <article key={archive.id} id={`${panelId}-${archive.id}`} data-archive-number={archive.number} data-archive-valid={archive.valid}>
                <strong>#{archive.number} · {fileLinks(archive.projectVersion)}</strong>
                {archive.preview && <p>{t("预览", "Preview")}: {fileLinks(archive.preview)}</p>}
                {archive.materials.length > 0 && <p>{t("素材", "Materials")}: {archive.materials.map(file => <span key={file.id}> {fileLinks(file)} </span>)}</p>}
                {archive.nextSteps && <p>{t("下一步", "Next steps")}: {archive.nextSteps}</p>}
                <small>{archive.createdBy} · <time dateTime={archive.createdAt}>{new Date(archive.createdAt).toLocaleString(zh ? "zh-CN" : "en-US")}</time>
                  {!archive.valid && ` · ${t("缺失", "Missing")}: ${archive.missing.join(", ")}`}</small>
              </article>
            ))}
          </div>
        );
      })}
    </section>
  );
}
