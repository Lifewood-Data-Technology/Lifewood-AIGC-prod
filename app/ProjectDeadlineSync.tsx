"use client";
import {deadlineTaskClosed, projectDeadlineTargets, type ProjectDeadlineSnapshot} from "../lib/project-date-sync";

type Row = Record<string, unknown>;
type Props = {
  inventory: ProjectDeadlineSnapshot; reviewed: ProjectDeadlineSnapshot | null;
  onReview: (snapshot: ProjectDeadlineSnapshot | null) => void;
  dueDate: string; projectStatus: string; locale: "zh" | "en";
  tasks: Row[]; videos: Row[];
};

/** A functional confirmation of existing dates; selecting sync never silently refreshes its reviewed set. */
export default function ProjectDeadlineSync({inventory, reviewed, onReview, dueDate, projectStatus, locale, tasks, videos}: Props) {
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const selected = projectDeadlineTargets(reviewed ?? inventory);
  const stale = reviewed !== null && reviewed.token !== inventory.token;
  const closed = deadlineTaskClosed(projectStatus);
  return <fieldset className="pm-deadline-sync">
    <legend>{t("日期修改范围", "Deadline update scope")}</legend>
    <label><input type="radio" name="deadline-sync" checked={reviewed === null} onChange={() => onReview(null)}/>{t("仅修改项目截止日期（默认）", "Project deadline only (default)")}</label>
    <label><input type="radio" name="deadline-sync" disabled={closed} checked={reviewed !== null} onChange={() => onReview(inventory)}/>{t("同步未交付任务及相关视频", "Also update unfinished tasks and their videos")}</label>
    {closed && <p className="pm-info">{t("已关闭项目不再同步任务日期。", "Closed projects cannot synchronize task deadlines.")}</p>}
    {reviewed === null ? <p className="pm-info">{t("视频和语言任务保留各自日期。", "Video and language task deadlines are retained.")}</p> : <>
      <p className="pm-info">{t(`将更新 ${selected.tasks.length} 个语言任务、${selected.videos.length} 个视频，统一为 ${dueDate}。这会覆盖它们独立设置的日期；已交付、归档和终止任务保留原日期。`, `Update ${selected.tasks.length} language task${selected.tasks.length === 1 ? "" : "s"} and ${selected.videos.length} video${selected.videos.length === 1 ? "" : "s"} to ${dueDate}. Their individual deadlines will be overwritten; delivered, archived and terminated tasks retain their dates.`)}</p>
      {stale && <p role="alert" className="pm-danger">{t("任务或视频已变化，保存前请重新核对影响范围。", "Tasks or videos changed. Review the affected items again before saving.")} <button type="button" onClick={() => onReview(inventory)}>{t("重新核对范围", "Review updated scope")}</button></p>}
      <details open={stale}><summary>{t("查看原日期 → 新日期", "Review old → new deadlines")}</summary><div className="pm-table-scroll"><table><thead><tr><th>{t("对象", "Item")}</th><th>{t("原日期", "Old deadline")}</th><th>{t("新日期", "New deadline")}</th></tr></thead><tbody>
        {selected.videos.map(video => <tr key={`video:${video.id}`}><td>{String(videos.find(row => row.id === video.id)?.name ?? video.id)}</td><td>{video.due_date || "—"}</td><td>{dueDate}</td></tr>)}
        {selected.tasks.map(task => {const row = tasks.find(row => row.id === task.id); return <tr key={`task:${task.id}`}><td>{String(row?.video_name ?? videos.find(video => video.id === task.video_id)?.name ?? task.video_id)} · {String(row?.language ?? row?.language_code ?? task.id)}</td><td>{task.due_date || "—"}</td><td>{dueDate}</td></tr>;})}
      </tbody></table></div></details>
    </>}
  </fieldset>;
}
