type ProgressRow = Record<string, unknown>;

export const progressStages = [
  { id: "planned", zh: "待制作", en: "To produce", color: "var(--progress-planned)" },
  { id: "production", zh: "制作中", en: "In production", color: "var(--progress-production)" },
  { id: "review", zh: "待质检", en: "In quality review", color: "var(--progress-review)" },
  { id: "revision", zh: "待修改", en: "Needs revision", color: "var(--progress-revision)" },
  { id: "approved", zh: "质检通过", en: "Quality approved", color: "var(--progress-approved)" },
  { id: "paused", zh: "已暂停", en: "Paused", color: "var(--progress-paused)" },
  { id: "other", zh: "待核对", en: "Needs checking", color: "var(--progress-other)" },
] as const;

export function taskProgressStage(task: ProgressRow) {
  const status = String(task.status ?? "");
  if (status === "已终止") return "terminated";
  if (status === "已暂停") return "paused";
  if (status === "待补充资料") return "planned";
  if (status === "待分配") return "planned";
  if (status === "制作中") return "production";
  if (status === "待质检") return "review";
  if (["质检驳回", "客户要求修改"].includes(status)) return "revision";
  if (["待客户预览", "待最终确认", "待交付", "已交付", "已归档"].includes(status)) return "approved";
  return "other";
}

export function projectProgress(tasks: ProgressRow[], today: string) {
  const active = tasks.filter(task => taskProgressStage(task) !== "terminated");
  const approved = active.filter(task => taskProgressStage(task) === "approved").length;
  const delivered = active.filter(task => ["已交付", "已归档"].includes(String(task.status))).length;
  const incomplete = active.filter(task => taskProgressStage(task) !== "approved");
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 3);
  const soonDate = soon.toISOString().slice(0, 10);
  return {
    total: active.length,
    approved,
    delivered,
    percent: active.length ? Math.floor(approved / active.length * 100) : 0,
    terminated: tasks.length - active.length,
    overdue: incomplete.filter(task => String(task.due_date ?? "").slice(0, 10) && String(task.due_date).slice(0, 10) < today).length,
    dueSoon: incomplete.filter(task => {
      const due = String(task.due_date ?? "").slice(0, 10);
      return due >= today && due <= soonDate;
    }).length,
    stages: progressStages.map(stage => ({ ...stage, tasks: active.filter(task => taskProgressStage(task) === stage.id) })),
  };
}

export function groupVideoTasks(tasks: ProgressRow[]) {
  const groups = new Map<string, { id: string; code: string; name: string; tasks: ProgressRow[] }>();
  for (const task of tasks) {
    // Never merge different videos merely because their language or title matches.
    const id = String(task.video_id || `unassigned-${task.id}`);
    if (!groups.has(id)) groups.set(id, {
      id,
      code: String(task.video_code || ""),
      name: String(task.video_name || ""),
      tasks: [],
    });
    groups.get(id)!.tasks.push(task);
  }
  return [...groups.values()];
}

export function salesOwnerOptions(rows: ProgressRow[]) {
  return [...new Map(rows.filter(row => row.sales_email).map(row => [
    String(row.sales_email), { email: String(row.sales_email), name: String(row.sales_name || row.sales_email) },
  ])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function shanghaiDay(value: string | number | Date = new Date()) {
  const normalized = typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : "";
}
export function shiftDay(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function weekStart(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}
export const portfolioBuckets = [
  { id: "not-started", zh: "尚未启动", en: "Not started", color: "var(--progress-planned)" },
  { id: "under-half", zh: "制作中 · 不足 50%", en: "In progress · below 50%", color: "var(--progress-production)" },
  { id: "over-half", zh: "制作中 · 50% 及以上", en: "In progress · 50% or more", color: "var(--progress-over-half)" },
  { id: "complete", zh: "制作完成", en: "Production complete", color: "var(--progress-approved)" },
] as const;
export function portfolioOverview(projects: ProgressRow[], tasks: ProgressRow[], quality: ProgressRow[], feedback: ProgressRow[], today: string) {
  const byProject = new Map<string, ProgressRow[]>();
  const visibleProjects = new Set(projects.map(project => String(project.id)));
  const visibleTasks = new Map<string, ProgressRow>();
  for (const task of tasks) {
    if (!visibleProjects.has(String(task.project_id)) || visibleTasks.has(String(task.id))) continue;
    visibleTasks.set(String(task.id), task);
    const projectId = String(task.project_id);
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId)!.push(task);
  }
  const allRows = projects.map(project => {
    const projectTasks = byProject.get(String(project.id)) || [];
    const progress = projectProgress(projectTasks, today);
    const activeTasks = projectTasks.filter(task => taskProgressStage(task) !== "terminated");
    const excluded = ["已归档", "已终止"].includes(String(project.workflow_status || project.status)) || (projectTasks.length > 0 && !progress.total);
    const bucket = progress.total > 0 && progress.approved === progress.total ? "complete"
      : activeTasks.every(task => taskProgressStage(task) === "planned") ? "not-started"
      : progress.approved / (progress.total || 1) < .5 ? "under-half" : "over-half";
    return { project, tasks: activeTasks, progress, excluded, bucket };
  });
  const rows = allRows.filter(row => !row.excluded);
  const includedTasks = rows.flatMap(row => row.tasks);
  const due = Array.from({ length: 7 }, (_, i) => {
    const day = shiftDay(today, i);
    const dayTasks = includedTasks.filter(task => String(task.due_date || "").slice(0, 10) === day);
    return { day, total: dayTasks.length, approved: dayTasks.filter(task => taskProgressStage(task) === "approved").length,
      projectIds: [...new Set(dayTasks.map(task => String(task.project_id)))] };
  });
  // Use recorded events, never a task's mutable updated_at, to construct history.
  const firstApproval = new Map<string, string>();
  const revisionEvents: { taskId: string; day: string }[] = [];
  for (const event of quality) {
    const taskId = String(event.language_project_id || "");
    const day = shanghaiDay(String(event.created_at || ""));
    if (!visibleTasks.has(taskId) || !day || day > today) continue;
    if (event.result === "approved" && (!firstApproval.has(taskId) || day < firstApproval.get(taskId)!)) firstApproval.set(taskId, day);
    if (event.result === "rejected") revisionEvents.push({ taskId, day });
  }
  for (const event of feedback) {
    const taskId = String(event.language_project_id || "");
    const day = shanghaiDay(String(event.created_at || ""));
    if (visibleTasks.has(taskId) && event.decision === "revision" && day && day <= today) revisionEvents.push({ taskId, day });
  }
  const weeks = Array.from({ length: 4 }, (_, i) => {
    const start = shiftDay(weekStart(today), (i - 3) * 7);
    const end = i === 3 ? today : shiftDay(start, 6);
    const approvedIds = [...firstApproval].filter(([, day]) => day >= start && day <= end).map(([id]) => id);
    const revisionIds = [...new Set(revisionEvents.filter(event => event.day >= start && event.day <= end).map(event => event.taskId))];
    const projectIds = (ids: string[]) => [...new Set(ids.map(id => String(visibleTasks.get(id)!.project_id)))];
    return { start, end, approved: approvedIds.length, revisions: revisionIds.length, approvedProjectIds: projectIds(approvedIds), revisionProjectIds: projectIds(revisionIds) };
  });
  const risks = (["overdue", "unassigned", "revision"] as const).map(id => {
    const matches = rows.filter(row => id === "overdue" ? row.progress.overdue > 0 : row.tasks.some(task => taskProgressStage(task) === (id === "unassigned" ? "planned" : id)));
    return { id, projectIds: matches.map(row => String(row.project.id)), count: matches.length, percent: rows.length ? Math.round(matches.length / rows.length * 100) : 0 };
  });
  return { rows, allRows, excluded: allRows.length - rows.length, due, weeks, risks,
    missingHistory: includedTasks.filter(task => taskProgressStage(task) === "approved" && !firstApproval.has(String(task.id))).length,
    buckets: portfolioBuckets.map(bucket => ({ ...bucket, count: rows.filter(row => row.bucket === bucket.id).length })),
    total: rows.length, incomplete: rows.filter(row => row.bucket !== "complete").length };
}

export type OverviewFilter = { kind: string; date: string; asOf: string };
const overviewKinds = ["all", "incomplete", "overdue", "unassigned", "revision", "not-started", "under-half", "over-half", "complete", "due", "week-approved", "week-revision"];
export function parseOverviewFilter(query: string, today: string): OverviewFilter | null {
  const params = new URLSearchParams(query);
  const kind = params.get("overview") || "";
  if (!overviewKinds.includes(kind)) return null;
  const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  const date = params.get("period") || "";
  if (["due", "week-approved", "week-revision"].includes(kind) && !validDay(date)) return null;
  const asOf = params.get("asof") || "";
  return { kind, date, asOf: validDay(asOf) ? asOf : today };
}
export function overviewProjectIds(data: ReturnType<typeof portfolioOverview>, filter: OverviewFilter) {
  const { kind, date } = filter;
  if (kind === "due") return new Set(data.due.find(item => item.day === date)?.projectIds || []);
  if (kind.startsWith("week-")) {
    const week = data.weeks.find(item => item.start === date);
    return new Set((kind === "week-approved" ? week?.approvedProjectIds : week?.revisionProjectIds) || []);
  }
  const risk = data.risks.find(item => item.id === kind);
  if (risk) return new Set(risk.projectIds);
  return new Set(data.rows.filter(row => kind === "all" || (kind === "incomplete" ? row.bucket !== "complete" : row.bucket === kind)).map(row => String(row.project.id)));
}
export function overviewFilterLabel(filter: OverviewFilter, locale: "zh" | "en") {
  const bucket = portfolioBuckets.find(item => item.id === filter.kind);
  if (bucket) return bucket[locale];
  const zh = locale === "zh";
  const labels: Record<string, string> = {
    all: zh ? "未归档项目" : "Unarchived projects", incomplete: zh ? "制作未完成" : "Production incomplete",
    overdue: zh ? "制作任务逾期" : "Overdue production tasks", unassigned: zh ? "待分配" : "Awaiting assignment", revision: zh ? "待修改" : "Needs revision",
    due: zh ? `${filter.date} 有任务到期` : `Tasks due ${filter.date}`,
    "week-approved": zh ? `${filter.date} 当周首次质检通过` : `First quality approvals in week of ${filter.date}`,
    "week-revision": zh ? `${filter.date} 当周发生返修` : `Revisions in week of ${filter.date}`,
  };
  return labels[filter.kind] || "";
}
