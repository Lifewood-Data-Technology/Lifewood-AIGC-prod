type Row = Record<string, unknown>;
const str = (value: unknown) => String(value ?? "");

/** Inputs are already scoped by assignment in SQL. Keep only their folder tree. */
export function assignedTaskFolders(folders: Row[], languages: Row[], access: string) {
  if (!["production", "quality"].includes(access)) return folders;
  const tasks = new Set(languages.map(row => str(row.id)));
  const videos = new Set(languages.map(row => str(row.video_id)).filter(Boolean));
  const projects = new Set(languages.map(row => str(row.project_id)));
  const byId = new Map(folders.map(row => [str(row.id), row]));
  const ancestors = new Set<string>();
  for (const folder of folders.filter(row => tasks.has(str(row.language_project_id)))) {
    let parent = byId.get(str(folder.parent_folder_id));
    const seen = new Set<string>();
    while (parent && !seen.has(str(parent.id))) { seen.add(str(parent.id)); ancestors.add(str(parent.id)); parent = byId.get(str(parent.parent_folder_id)); }
  }
  return folders.filter(folder => {
    if (str(folder.node_type).startsWith("library")) return access === "production";
    if (!projects.has(str(folder.project_id))) return false;
    let cursor: Row | undefined = folder;
    const seen = new Set<string>();
    while (cursor && !seen.has(str(cursor.id))) {
      seen.add(str(cursor.id));
      if (cursor.language_project_id) return tasks.has(str(cursor.language_project_id));
      if (cursor.video_id) return videos.has(str(cursor.video_id));
      if (cursor.node_type === "project_info") return true;
      cursor = byId.get(str(cursor.parent_folder_id));
    }
    return ancestors.has(str(folder.id)) || ["project", "videos", "client"].includes(str(folder.node_type));
  });
}

/** Reviewers see references, submitted versions and reports, never working drafts. */
export function qualityFileVisible(file: Row) {
  const status = str(file.version_status ?? file.status);
  if (status === "quality_report" || file.source === "generated-quality-report") return true;
  const path = str(file.folder_path || file.directory || file.folder_code);
  if (/(?:^|\/)(?:01|02|04)(?:_|\.|$)/.test(path)) return true;
  return ["pending_qc", "qc_approved", "qc_rejected", "customer_revision_requested", "final", "delivered"].includes(status);
}

export const progressEditableStatuses = ["待制作", "制作中", "质检驳回", "客户要求修改"];
export function validProductionProgress(value: unknown) {
  return typeof value === "string" && /^(?:100|[1-9]?\d)$/.test(value);
}
