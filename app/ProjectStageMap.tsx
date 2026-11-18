"use client";

import { useRef, useState } from "react";
import { detailStages, filterStageRows, projectStageMap, stageStatusLabel } from "../lib/project-stage-map";
import SelectControl from "./SelectControl";
import ProjectProgressCharts from "./ProjectProgressCharts";

type Row = Record<string, unknown>;
export default function ProjectStageMap({ project, videos, tasks, team, locale }: {
  project: Row; videos: Row[]; tasks: Row[]; team: Row[]; locale: "zh" | "en";
}) {
  const [stageFilter, setStageFilter] = useState("");
  const [videoFilter, setVideoFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const zh = locale === "zh";
  const data = projectStageMap(project, videos, tasks, team, locale);
  const roles = { sales: zh ? "销售跟进" : "Sales follow-up", manager: zh ? "项目负责人" : "Project manager", editor: zh ? "剪辑师" : "Editor", reviewer: zh ? "质检员" : "Reviewer", none: zh ? "本任务已结束" : "Task closed" };
  const exceptionLabels: Record<string, string> = { paused: zh ? "已暂停" : "Paused", terminated: zh ? "已终止" : "Terminated", unknown: zh ? "状态待核对" : "Needs checking" };
  const people = [...new Map(data.rows.flatMap(row => [row.owner, row.editor, row.reviewer]).filter(person => person.email).map(person => [person.email, person])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = data.groups.filter(group => !videoFilter || group.id === videoFilter).map(group => ({ ...group, rows: filterStageRows(group.rows, stageFilter, ownerFilter) })).filter(group => group.rows.length || (!stageFilter && !ownerFilter));
  const visibleCount = filtered.reduce((sum, group) => sum + group.rows.length, 0);
  const revealDetails = () => {
    setDetailsOpen(true);
    requestAnimationFrame(() => {
      detailsRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      detailsRef.current?.querySelector("summary")?.focus({ preventScroll: true });
    });
  };
  return <section className="project-stage-map" aria-label={zh ? "项目整体进度图表" : "Overall project progress charts"}>
    <ProjectProgressCharts data={data} locale={locale}
      onStage={id => { setStageFilter(id); setVideoFilter(""); setOwnerFilter(""); revealDetails(); }}
      onVideo={id => { setVideoFilter(id); setStageFilter(""); setOwnerFilter(""); revealDetails(); }} />
    <details className="psm-task-details" ref={detailsRef} open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>{zh ? "语言任务与负责人明细" : "Language tasks and assignee details"}<small>{zh ? "按需展开，不影响上方整体统计" : "Expand when needed; overall charts remain unchanged"}</small></summary>
    <div className="psm-filters filter-group">
      <div className="filter-group-heading"><strong>{zh ? "筛选条件" : "Filters"}</strong><small>{zh ? "按视频和参与人员查看任务" : "View tasks by video and assignee"}</small></div>
      <label><span>{zh ? "视频" : "Video"}</span><SelectControl locale={locale} value={videoFilter} onChange={event => setVideoFilter(event.target.value)}><option value="">{zh ? "全部视频" : "All videos"}</option>{data.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</SelectControl></label>
      <label><span>{zh ? "参与人员" : "People involved"}</span><SelectControl locale={locale} value={ownerFilter} onChange={event => setOwnerFilter(event.target.value)}><option value="">{zh ? "全部人员" : "All people"}</option><option value="unassigned">{zh ? "当前跟进人未分配" : "Current owner unassigned"}</option>{people.map(person => <option key={person.email} value={person.email}>{person.name}</option>)}</SelectControl></label>
      <button type="button" className="link-button query-reset-button" onClick={() => { setStageFilter(""); setVideoFilter(""); setOwnerFilter(""); }}>{zh ? "重置筛选" : "Reset filters"}</button>
      <span className="psm-result-count" role="status">{zh ? `显示 ${visibleCount} / ${data.rows.length} 项任务` : `Showing ${visibleCount} / ${data.rows.length} tasks`}{stageFilter ? ` · ${data.stages.find(stage => stage.id === stageFilter)?.[locale] || exceptionLabels[stageFilter]}` : ""}</span>
    </div>
    <div className="psm-video-groups">
      {filtered.map(group => <details key={group.id} className="psm-video" open>
        <summary><span>{group.name}</span><small>{group.rows.length} {zh ? "项语言任务" : "language tasks"}</small></summary>
        {group.rows.length ? <div className="psm-table-wrap"><table className="psm-table"><caption>{group.name} · {zh ? "阶段与人员" : "Stages and people"}</caption><thead><tr><th scope="col">{zh ? "语言任务" : "Language task"}</th><th scope="col">{zh ? "当前阶段" : "Current stage"}</th><th scope="col">{zh ? "当前跟进人" : "Current owner"}</th><th scope="col">{zh ? "制作 / 质检分工" : "Production / QC assignment"}</th></tr></thead><tbody>
          {group.rows.map(row => <tr key={row.id} data-task-id={row.id}>
            <td className="psm-task-identity"><strong>{String(row.task.language || row.task.language_code || (zh ? "语言待确认" : "Language to confirm"))}</strong><small>{String(row.task.language_code || "")}</small></td>
            <td><div className="psm-task-status"><strong className={row.exception || row.revision ? "needs-attention" : ""}>{stageStatusLabel(row.status, locale)}</strong>{row.exception === "paused" && <small>{zh ? "暂停前：" : "Paused at: "}{detailStages.find(stage => stage.id === row.stage)?.[locale] || (zh ? "阶段未记录" : "Stage not recorded")}</small>}</div></td>
            <td><span className="psm-mobile-label">{zh ? "当前跟进人" : "Current owner"}</span><strong className={row.unassigned ? "needs-attention" : ""}>{row.owner.name}</strong><small>{roles[row.role]}</small></td>
            <td><div className="psm-assignment"><span>{zh ? "剪辑" : "Editor"}</span><strong>{row.editor.name}</strong></div><div className="psm-assignment"><span>{zh ? "质检" : "Reviewer"}</span><strong>{row.reviewer.name}</strong></div></td>
          </tr>)}
        </tbody></table></div> : <p className="psm-empty">{zh ? "尚未创建语言任务，请在下方分配任务。" : "No language tasks yet. Set up tasks below."}</p>}
      </details>)}
      {!filtered.length && <p className="psm-empty">{data.rows.length ? (zh ? "没有符合筛选条件的任务。" : "No tasks match these filters.") : (zh ? "项目尚未创建视频和语言任务。创建后会在此显示进度及负责人。" : "No videos or language tasks yet. Their stages and owners will appear here once created.")}</p>}
    </div>
    </details>
  </section>;
}
