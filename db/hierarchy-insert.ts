import type { Database, DatabaseStatement } from "./database";
import { PublicError } from "../lib/security-controls";

export type InsertRow = (string | number | null)[];
const shapes = {
  // 240 tasks × 22 category nodes, plus project/video ancestors. Business limits stay 30 × 8.
  folders: { table: "aigc_folders", columns: ["id", "language_project_id", "client_id", "project_id", "video_id", "node_type", "parent_folder_id", "folder_code", "name", "name_zh", "name_en", "path_cache", "depth", "is_system", "sort_order", "created_by", "created_at", "updated_at"], ignore: true, maxRows: 6000 },
  videos: { table: "project_videos", columns: ["id", "project_id", "video_code", "root_folder_id", "name", "name_zh", "name_en", "brief", "duration_seconds", "aspect_ratio", "priority", "due_date", "sort_order", "updated_at"], ignore: false, maxRows: 30 },
  tasks: { table: "language_projects", columns: ["id", "project_id", "video_id", "project_type_id", "language", "language_code", "status", "requirements", "material_standard_version", "due_date", "updated_at"], ignore: false, maxRows: 240 },
} as const;

/** Fixed identifiers, bound values, UTF-8 byte-bounded chunks. All chunks must
 * stay inside the caller's single guarded transaction; never commit piecemeal. */
export function hierarchyInsertStatements(db: Database, kind: keyof typeof shapes, rows: readonly InsertRow[]): DatabaseStatement[] {
  if (!rows.length) return [];
  const shape = shapes[kind];
  if (rows.length > shape.maxRows) throw new PublicError("This project exceeds the supported video or language limit.", 400, "PROJECT_CREATE_TOO_LARGE");
  const maxBytes = 256 * 1024;
  const encoder = new TextEncoder();
  const sql = `INSERT ${shape.ignore ? "OR IGNORE " : ""}INTO ${shape.table} (${shape.columns.join(", ")}) SELECT ${shape.columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?) ORDER BY CAST(key AS INTEGER)`;
  const statements: DatabaseStatement[] = [];
  let parts: string[] = [], size = 2;
  const flush = () => { if (parts.length) statements.push(db.prepare(sql).bind(`[${parts.join(",")}]`)); parts = []; size = 2; };
  for (const row of rows) {
    if (row.length !== shape.columns.length || row.some(value => value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))) throw Error("Invalid internal hierarchy insert row.");
    const encoded = JSON.stringify(row), bytes = encoder.encode(encoded).byteLength;
    if (bytes + 2 > maxBytes) throw new PublicError("The project description is too large. Shorten it before accepting.", 400, "PROJECT_CREATE_TOO_LARGE");
    if (parts.length && size + 1 + bytes > maxBytes) flush();
    size += (parts.length ? 1 : 0) + bytes;
    parts.push(encoded);
  }
  flush();
  return statements;
}
