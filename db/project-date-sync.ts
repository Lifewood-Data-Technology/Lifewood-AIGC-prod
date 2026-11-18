import type {Database, DatabaseStatement} from "./database";
import {PublicError} from "../lib/security-controls";
import {deadlineTaskClosed, projectDeadlineSnapshot, projectDeadlineTargets} from "../lib/project-date-sync";

type Project = {id: string; due_date: string; status: string};
type Plan = {sql: string; values: (string | number | null)[]; statements: DatabaseStatement[]; tasks: number; videos: number};

/** Read a complete inventory, then fence that same set inside the caller's atomic mutation. */
export async function prepareProjectDateSync(db: Database, project: Project, dueDate: string, now: string, mode?: string, reviewedToken?: string): Promise<Plan> {
  if (mode !== undefined && mode !== "project" && mode !== "unfinished") throw new PublicError("Invalid deadline synchronization choice.");
  const none: Plan = {sql: "1 = 1", values: [], statements: [], tasks: 0, videos: 0};
  if (mode !== "unfinished" || dueDate === project.due_date) return none;
  if (deadlineTaskClosed(project.status)) throw new PublicError("Closed projects cannot synchronize task deadlines.");
  const taskRows = await db.prepare("SELECT id,project_id,revision,status,due_date,video_id,editor_email,reviewer_email FROM language_projects WHERE project_id = ?").bind(project.id).all<Record<string, unknown>>();
  const videoRows = await db.prepare("SELECT id,project_id,revision,due_date FROM project_videos WHERE project_id = ?").bind(project.id).all<Record<string, unknown>>();
  const snapshot = projectDeadlineSnapshot(project.id, taskRows.results, videoRows.results);
  if (!reviewedToken || reviewedToken !== snapshot.token) throw new PublicError("Deadline targets changed. Refresh and review the affected tasks again.", 409, "STALE_RECORD");
  const selected = projectDeadlineTargets(snapshot);
  // Equality includes IDs/counts, revision, status, dates and assignments. This catches inserts,
  // deliveries and reassignments after the preview, even if an old writer omitted a revision bump.
  const guards = [
    {table: "language_projects", rows: snapshot.tasks, fields: ["status", "due_date", "video_id", "editor_email", "reviewer_email"]},
    {table: "project_videos", rows: snapshot.videos, fields: ["due_date"]},
  ];
  const values: Plan["values"] = [], conditions: string[] = [];
  for (const {table, rows, fields} of guards) {
    conditions.push(`(SELECT COUNT(*) FROM ${table} WHERE project_id = ?) = ? AND NOT EXISTS (SELECT 1 FROM ${table} deadline_current WHERE deadline_current.project_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(?) deadline_review WHERE json_extract(deadline_review.value,'$.id') = deadline_current.id AND json_extract(deadline_review.value,'$.revision') = deadline_current.revision ${fields.map(field => `AND json_extract(deadline_review.value,'$.${field}') = COALESCE(deadline_current.${field},'')`).join(" ")}))`);
    values.push(project.id, rows.length, project.id, JSON.stringify(rows));
  }
  const statements: DatabaseStatement[] = [];
  for (const [table, rows] of [["language_projects", selected.tasks], ["project_videos", selected.videos]] as const) {
    if (rows.length) statements.push(db.prepare(`UPDATE ${table} SET due_date = ?, updated_at = ?, revision = revision + 1 WHERE project_id = ? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(dueDate, now, project.id, JSON.stringify(rows)));
  }
  return {sql: conditions.map(sql => `(${sql})`).join(" AND "), values, statements, tasks: selected.tasks.length, videos: selected.videos.length};
}
