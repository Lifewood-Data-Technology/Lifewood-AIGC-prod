"use client";
import { useState } from "react";
import { activeWork, currentProjectAssignments, teamDirectory, teamRoles } from "../lib/team-directory";
import { stageStatusLabel } from "../lib/project-stage-map";
import SelectControl from "./SelectControl";
import DataList, { DataListTable } from "./DataList";
import { SearchIcon } from "./ControlIcons";
import Pagination from "./TablePagination";
type Row = Record<string, unknown>;
export default function TeamDirectory({ team, projects, tasks, access, locale, initialQuery = "", onProject }: {
  team: Row[]; projects: Row[]; tasks: Row[]; access: string; locale: "zh" | "en"; initialQuery?: string; onProject: (id: string) => void;
}) {
  const params = new URLSearchParams(initialQuery);
  const [tab, setTab] = useState(params.get("tab") === "workload" ? "workload" : "members");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [projectId, setProjectId] = useState(params.get("project") || "");
  const zh = locale === "zh";
  const labels: Record<string, string> = zh ? { client: "销售", project: "项目负责人", production: "剪辑师", quality: "质检员" } : { client: "Sales", project: "Project manager", production: "Editor", quality: "Reviewer" };
  const workload = tab === "workload";
  const rows = teamDirectory(team, query, role, workload);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const selectedProject = access === "project" ? projects.find(project => project.id === projectId) : undefined;
  const scope = String(selectedProject?.id || "");
  if (access !== "project") return null;
  return <section className="team-directory">
    <header className="page-heading"><div><span className="eyebrow">Lifewood AIGC</span><h1>{zh ? "团队成员" : "Team members"}</h1></div>{selectedProject && <button className="secondary-button" onClick={() => onProject(scope)}>{zh ? "返回项目" : "Back to project"}</button>}</header>
    <div className="team-tabs" role="tablist" aria-label={zh ? "团队视图" : "Team view"}>{["members", "workload"].map(id => <button key={id} id={`team-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="team-panel" tabIndex={tab === id ? 0 : -1} onClick={() => { setTab(id); setRole(""); setPage(1); }} onKeyDown={event => { if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "members" : event.key === "End" ? "workload" : tab === "members" ? "workload" : "members"; setTab(next); setRole(""); setPage(1); document.getElementById(`team-tab-${next}`)?.focus(); } }}>{id === "members" ? zh ? "团队成员" : "Team members" : zh ? "团队负载" : "Team workload"}</button>)}</div>
    <div className="sales-list-layout" id="team-panel" role="tabpanel" aria-labelledby={`team-tab-${tab}`}>
    <DataList className="team-data-list" ariaLabel={workload ? zh ? "团队负载" : "Team workload" : zh ? "团队成员" : "Team members"}
      toolbar={<><label className="team-search"><SearchIcon /><input aria-label={zh ? "姓名或邮箱" : "Name or email"} value={query} placeholder={zh ? "搜索团队成员…" : "Search colleagues…"} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label>
        <label className="data-list-field team-role-filter"><span>{zh ? "角色" : "Role"}</span><SelectControl locale={locale} aria-label={zh ? "角色" : "Role"} value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><option value="">{zh ? "全部角色" : "All roles"}</option>{teamRoles.filter(id => !workload || ["production", "quality"].includes(id)).map(id => <option key={id} value={id}>{labels[id]}</option>)}</SelectControl></label>
        {workload && access === "project" && <label className="data-list-field team-project-filter"><span>{zh ? "项目对照" : "Compare with project"}</span><SelectControl locale={locale} aria-label={zh ? "项目对照" : "Compare with project"} value={scope} onChange={event => { setProjectId(event.target.value); setPage(1); }}><option value="">{zh ? "不选择项目" : "No project selected"}</option>{projects.map(project => <option key={String(project.id)} value={String(project.id)}>{String(project.name)}</option>)}</SelectControl></label>}
        <div className="data-list-query-actions"><button className="link-button query-reset-button" onClick={() => { setQuery(""); setRole(""); setProjectId(""); setPage(1); }}>{zh ? "重置筛选" : "Reset filters"}</button></div>
      </>}
      summary={<><strong>{workload ? zh ? "团队负载" : "Team workload" : zh ? "团队成员" : "Team members"}</strong><span>{rows.length} / {team.length}</span></>}
      pagination={<Pagination locale={locale} page={currentPage} pageSize={pageSize} total={rows.length} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} />}>
      {workload && <p className="team-work-note">{zh ? "在办数为全部项目中当前正在剪辑或等待质检的语言任务数，不代表工时或负载百分比。暂停、已完成和仅预先分配的任务不计入。" : "Active counts cover all projects: tasks currently being edited or awaiting QC, not hours or a capacity percentage. Paused, completed and future assignments are excluded."}{selectedProject && (zh ? ` 项目对照：${String(selectedProject.name)}，包含本项目已分配但尚未结束的任务。` : ` Project comparison: ${String(selectedProject.name)}, including assigned tasks not yet closed.`)}</p>}
      <DataListTable className="team-table-wrap" ariaLabel={workload ? zh ? "团队负载" : "Team workload" : zh ? "团队成员" : "Team members"}><table className="work-table"><caption>{workload ? zh ? "制作与质检负载" : "Production and QC workload" : zh ? "在职成员名录" : "Active team directory"}</caption><thead><tr><th>{zh ? "姓名" : "Name"}</th><th>{zh ? "角色" : "Role"}</th><th>{zh ? "工作邮箱" : "Work email"}</th>{workload && <><th>{zh ? "全部项目在办" : "Active · all projects"}</th><th>{zh ? "最近截止" : "Nearest due date"}</th>{scope && <th>{zh ? "本项目分配" : "Assigned on this project"}</th>}</>}</tr></thead><tbody>
        {rows.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(person => <tr key={String(person.email)} data-team-email={String(person.email)}><td><strong>{String(person.name)}</strong></td><td>{labels[String(person.access_group)]}</td><td><a href={`mailto:${String(person.email)}`}>{String(person.email)}</a></td>{workload && <><td><strong className="team-count">{activeWork(person)}</strong> {zh ? "项" : "tasks"}</td><td>{String(person.nearest_due_date || "—")}</td>{scope && <td>{(() => { const assigned = currentProjectAssignments(person, tasks, scope); return assigned.length ? <details><summary>{assigned.length} {zh ? "项任务" : "tasks"}</summary><ul>{assigned.map(task => <li key={String(task.id)}>{String(task.video_name || selectedProject?.name || "")} · {String(task.language || task.language_code)} · {stageStatusLabel(String(task.status), locale)}</li>)}</ul></details> : "—"; })()}</td>}</>}</tr>)}
        {!rows.length && <tr><td colSpan={workload ? scope ? 6 : 5 : 3} className="team-empty">{zh ? "没有符合条件的团队成员。" : "No team members match your filters."}</td></tr>}
      </tbody></table></DataListTable>
    </DataList></div>
  </section>;
}
