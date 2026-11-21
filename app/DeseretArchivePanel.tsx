"use client";
// Internal production archives of Deseret tasks (AIGC only): list, register from existing task files, and the
// incoming editor's handover verification. Never shown to quality reviewers; nothing here is sent to Deseret.
import { useId, useState } from "react";
import { filePreviewKind } from "../lib/request-security";
import { publishableArchive, type DeseretArchiveFile, type DeseretArchive, type DeseretWorkspace } from "../lib/deseret-workspace";
import SelectControl from "./SelectControl";

type Command = (action: DeseretWorkspace["actions"][number], payload: Record<string, unknown>) => Promise<void>;
/** Task statuses closed to internal archives (mirrors the service rule). */
export const archiveClosedStatuses = ["待分配", "待补充资料", "已暂停", "已交付", "已归档", "已终止"];

/** The newest valid archive of a task that still counts after its latest handover reported missing work. */
export function usableArchives(data: DeseretWorkspace, taskId: string): DeseretArchive[] {
  return (data.archives ?? []).filter(archive => archive.taskId === taskId && publishableArchive(archive, data.handovers ?? []));
}

export default function DeseretArchivePanel({ data, taskId, locale, busy, command, onUpload }: {
  data: DeseretWorkspace; taskId?: string; locale: "en" | "zh"; busy: boolean; command: Command; onUpload?: (taskId: string) => void;
}) {
  const zh = locale === "zh", t = (cn: string, en: string) => zh ? cn : en;
  const tasks = data.tasks.filter(task => !taskId || task.id === taskId);
  const openTasks = tasks.filter(task => !archiveClosedStatuses.includes(task.status));
  const [chosenTask, setChosenTask] = useState("");
  const formTask = openTasks.find(task => task.id === chosenTask)?.id ?? openTasks[0]?.id ?? "";
  const [projectVersion, setProjectVersion] = useState(""), [preview, setPreview] = useState("");
  const [materials, setMaterials] = useState<string[]>([]), [nextSteps, setNextSteps] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const candidates = (data.archiveCandidates ?? []).filter(file => file.taskId === formTask);
  const label = (id: string) => data.tasks.find(task => task.id === id)?.language ?? id;
  const can = (action: DeseretWorkspace["actions"][number]) => data.actions.includes(action);
  const reset = () => { setProjectVersion(""); setPreview(""); setMaterials([]); setNextSteps(""); };
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
  return (
    <section className="pm-detail-card" data-section="deseret-archive">
      <h4>{t("内部留档", "Internal archive")}</h4>
      <p>{t("仅保存在 AIGC 内部，用于续作和交接，不会发送给出版社。", "Kept inside AIGC for continuing and handing over work; never sent to the publisher.")}</p>
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
        return (
          <div key={task.id}>
            <h5>{task.language}</h5>
            {workFiles.length > 0 && <details>
              <summary>{t("接手任务的文件和共享素材", "Task files and shared materials")}</summary>
              <ul>{workFiles.map(file => <li key={file.id}>{fileLinks(file)}</li>)}</ul>
            </details>}
            {!archives.length && <p>{t("暂无留档。", "No archive yet.")}</p>}
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
      {can("archive.register") && openTasks.length > 0 && (
        <form onSubmit={event => {
          event.preventDefault();
          if (!projectVersion || busy) return;
          void command("archive.register", { taskId: formTask, projectVersionId: projectVersion, ...(preview ? { previewVersionId: preview } : {}), materialVersionIds: materials, nextSteps: nextSteps.trim() })
            .then(reset).catch(() => {});
        }}>
          <fieldset disabled={busy}>
            <legend>{t("登记留档（选择本任务已保存的文件）", "Register an archive from this task's saved files")}</legend>
            {openTasks.length > 1 && (
              <label>{t("语言任务", "Language task")}
                <SelectControl locale={locale} name="archive-task" value={formTask} onChange={event => { setChosenTask(event.target.value); reset(); }}>
                  {openTasks.map(task => <option key={task.id} value={task.id}>{task.language}</option>)}
                </SelectControl>
              </label>
            )}
            <label>{t("工程文件 *", "Engineering file *")}
              <SelectControl locale={locale} name="archive-project" value={projectVersion} onChange={event => setProjectVersion(event.target.value)}>
                <option value="">{t("选择工程文件版本", "Choose an engineering file version")}</option>
                {candidates.filter(file => file.kind === "project").map(file => <option key={file.id} value={file.id}>{file.name} · v{file.version}</option>)}
              </SelectControl>
            </label>
            <label>{t("预览视频（选填）", "Preview video (optional)")}
              <SelectControl locale={locale} name="archive-preview" value={preview} onChange={event => setPreview(event.target.value)}>
                <option value="">{t("不选择", "None")}</option>
                {candidates.filter(file => file.kind === "video").map(file => <option key={file.id} value={file.id}>{file.name} · v{file.version}</option>)}
              </SelectControl>
            </label>
            <fieldset>
              <legend>{t("素材（选填）", "Materials (optional)")}</legend>
              {candidates.filter(file => file.kind !== "project" && file.id !== preview).map(file => (
                <label key={file.id}><input type="checkbox" name="archive-material" value={file.id} checked={materials.includes(file.id)}
                  onChange={event => setMaterials(event.target.checked ? [...materials, file.id] : materials.filter(id => id !== file.id))} />{file.name} · v{file.version}</label>
              ))}
            </fieldset>
            <label>{t("下一步（选填）", "Next steps (optional)")}
              <textarea name="archive-next-steps" maxLength={4000} value={nextSteps} onChange={event => setNextSteps(event.target.value)} />
            </label>
            <button type="submit" className="primary-button" disabled={busy || !projectVersion}>{t("登记留档", "Register archive")}</button>
            {data.role === "producer" && onUpload && (
              <button type="button" onClick={() => onUpload(formTask)}>{t("上传工程并留档", "Upload engineering file and archive")}</button>
            )}
            {!candidates.some(file => file.kind === "project") && <p role="status">{t("本任务还没有已保存的工程文件，可先上传。", "This task has no saved engineering file yet; upload one first.")}</p>}
          </fieldset>
        </form>
      )}
    </section>
  );
}
