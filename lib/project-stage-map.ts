type Row = Record<string, unknown>;
type Locale = "zh" | "en";
const str = (value: unknown) => String(value ?? "").trim();

export const detailStages = [
  { id: "assignment", zh: "任务分配", en: "Assignment" },
  { id: "production", zh: "视频制作", en: "Production" },
  { id: "quality", zh: "内部质检", en: "Quality review" },
  { id: "customer", zh: "客户确认", en: "Customer review" },
  { id: "done", zh: "交付完成", en: "Delivered" },
] as const;
export type DetailStage = typeof detailStages[number]["id"];
type OwnerRole = "sales" | "manager" | "editor" | "reviewer" | "none";
// These are current workflow positions, not inferred completion events.
const states: Record<string, { stage: DetailStage; role: OwnerRole; en: string }> = {
  "待补充资料": { stage: "assignment", role: "manager", en: "Awaiting assignment" },
  "待分配": { stage: "assignment", role: "manager", en: "Awaiting assignment" },
  "制作中": { stage: "production", role: "editor", en: "In production" },
  "质检驳回": { stage: "production", role: "editor", en: "QC revision required" },
  "客户要求修改": { stage: "production", role: "editor", en: "Customer revision required" },
  "待质检": { stage: "quality", role: "reviewer", en: "Awaiting quality review" },
  "待客户预览": { stage: "customer", role: "sales", en: "Awaiting customer preview" },
  "待最终确认": { stage: "customer", role: "manager", en: "Awaiting PM confirmation" },
  "待交付": { stage: "customer", role: "manager", en: "Awaiting PM confirmation" },
  "已交付": { stage: "done", role: "none", en: "Delivered" },
  "已归档": { stage: "done", role: "none", en: "Archived" },
};
export function stageStatusLabel(status: string, locale: Locale) {
  if (status === "待补充资料") status = "待分配";
  if (status === "待交付") status = "待最终确认";
  if (!status) return locale === "zh" ? "状态待核对" : "Status needs checking";
  return locale === "zh" ? status : states[status]?.en ?? ({ "已暂停": "Paused", "已终止": "Terminated" }[status] || status);
}
export function stagePerson(email: unknown, name: unknown, team: Row[], locale: Locale) {
  const address = str(email);
  // Never reuse a stale name when the assignment email has been cleared.
  if (!address) return { email: "", name: locale === "zh" ? "未分配" : "Unassigned" };
  return { email: address, name: str(team.find(person => str(person.email) === address)?.name) || str(name) || address };
}
export function projectStageMap(project: Row, videos: Row[], tasks: Row[], team: Row[], locale: Locale) {
  const projectId = str(project.id);
  const manager = stagePerson(project.project_owner_email, project.project_owner_name, team, locale);
  const sales = stagePerson(project.sales_email, project.sales_name, team, locale);
  const rows = tasks.filter(task => str(task.project_id) === projectId).map(task => {
    const status = str(task.status);
    const state = states[status];
    const paused = status === "已暂停";
    const terminated = status === "已终止";
    const stage = (paused ? states[str(task.paused_from_status)]?.stage : state?.stage) ?? null;
    const role: OwnerRole = paused || (!state && !terminated) ? "manager" : state?.role ?? "none";
    const editor = stagePerson(task.editor_email, task.editor_name, team, locale);
    const reviewer = stagePerson(task.reviewer_email, task.reviewer_name, team, locale);
    const owner = { sales, manager, editor, reviewer, none: { email: "", name: locale === "zh" ? "无需跟进" : "No action needed" } }[role];
    const exception = paused ? "paused" : terminated ? "terminated" : !state ? "unknown" : "";
    return { task, id: str(task.id), videoId: str(task.video_id), status, stage, role, owner, editor, reviewer, exception,
      revision: ["质检驳回", "客户要求修改"].includes(status),
      // Paused-at-delivery is not a delivered task.
      delivered: !exception && stage === "done",
      unassigned: role !== "none" && !owner.email,
    };
  });
  const groups = videos.filter(video => str(video.project_id) === projectId)
    .slice().sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
    .map(video => ({ id: str(video.id), name: str(video.name) || (locale === "zh" ? "未命名视频" : "Untitled video"), code: str(video.video_code), rows: rows.filter(row => row.videoId === str(video.id)) }));
  const knownIds = new Set(groups.map(group => group.id));
  // Missing or legacy video links stay visible, never merged by language/name.
  for (const row of rows) {
    if (knownIds.has(row.videoId)) continue;
    const id = `unlinked-${row.id}`;
    groups.push({ id, name: str(row.task.video_name) || (locale === "zh" ? "视频归属待核对" : "Video link needs checking"), code: str(row.task.video_code), rows: [row] });
  }
  const active = rows.filter(row => row.exception !== "terminated");
  const delivered = rows.filter(row => row.delivered).length;
  return { manager, sales, rows, groups, delivered, active: active.length,
    percent: active.length ? Math.floor(delivered / active.length * 100) : 0,
    stages: detailStages.map(stage => ({ ...stage, count: rows.filter(row => !row.exception && row.stage === stage.id).length })),
    exceptions: ["paused", "terminated", "unknown"].map(id => ({ id, count: rows.filter(row => row.exception === id).length })),
  };
}
export type StageMapRow = ReturnType<typeof projectStageMap>["rows"][number];
export function completionOfRows(rows: StageMapRow[]) {
  const active = rows.filter(row => row.exception !== "terminated");
  const approved = active.filter(row => !row.exception && ["customer", "delivery", "done"].includes(row.stage || "")).length;
  const delivered = active.filter(row => row.delivered).length;
  return { total: active.length, approved, delivered, terminated: rows.length - active.length,
    productionPercent: active.length ? Math.floor(approved / active.length * 100) : 0,
    deliveryPercent: active.length ? Math.floor(delivered / active.length * 100) : 0,
  };
}
export function projectChartSummary(data: ReturnType<typeof projectStageMap>) {
  return { ...completionOfRows(data.rows),
    unplannedVideos: data.groups.filter(group => !group.rows.length).length,
    videos: data.groups.map(group => ({ ...group, ...completionOfRows(group.rows) })),
  };
}
export function filterStageRows(rows: StageMapRow[], stage: string, owner: string) {
  return rows.filter(row => (!stage || row.exception === stage || (!row.exception && row.stage === stage)) &&
    (!owner || (owner === "unassigned" ? row.unassigned : [row.owner.email, row.editor.email, row.reviewer.email].includes(owner))));
}
