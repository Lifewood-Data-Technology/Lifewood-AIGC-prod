import type {Database} from "./database";
/** Resolve display names from actual ancestry, never parse names out of path_cache. */
export async function resolveStorageFolders(db: Database, folderId: string, environment: string | undefined): Promise<string[]> {
  if (!["test","audit"].includes(environment||"")) return [];
  const names: string[] = [], seen = new Set<string>();
  let id = folderId;
  while (id) {
    if (seen.has(id) || seen.size >= 40) throw new Error("Invalid storage folder ancestry.");
    seen.add(id);
    const row = await db.prepare(`SELECT f.*, c.name AS client_display, p.name AS project_display,
      pv.name AS video_display FROM aigc_folders f LEFT JOIN clients c ON c.id=f.client_id
      LEFT JOIN projects p ON p.id=f.project_id LEFT JOIN project_videos pv ON pv.id=f.video_id
      WHERE f.id=? AND f.deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
    if (!row) throw new Error("Storage folder is unavailable.");
    const kind = String(row.node_type);
    const name = kind === "client" ? row.client_display : kind === "project" ? row.project_display
      : kind === "video" ? row.video_display : row.name_zh || row.name;
    // The structural Videos node adds no information between project and video.
    if (kind !== "videos") names.unshift(kind === "directory"
      ? String(name || "文件夹").replace(/^\d+_/, "") : String(name || "文件夹"));
    id = String(row.parent_folder_id || "");
  }
  return names;
}
