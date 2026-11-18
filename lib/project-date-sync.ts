import { sha256 } from "@noble/hashes/sha2.js";

type Row = Record<string, unknown>;
export type DeadlineTask = {
  id: string; revision: number; status: string; due_date: string;
  video_id: string; editor_email: string; reviewer_email: string;
};
export type DeadlineVideo = { id: string; revision: number; due_date: string };
export type ProjectDeadlineSnapshot = {
  token: string; tasks: DeadlineTask[]; videos: DeadlineVideo[];
};
const closedStates = new Set(["已交付", "已归档", "已终止", "delivered", "archived", "terminated"]);
export const deadlineTaskClosed = (status: string) => closedStates.has(status);

/** Both callers supply the full project inventory, including closed tasks. */
export function projectDeadlineSnapshot(projectId: string, tasks: Row[], videos: Row[]): ProjectDeadlineSnapshot {
  const text = (value: unknown) => String(value ?? "");
  const revision = (value: unknown) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) throw new Error("Deadline inventory has no valid revision.");
    return result;
  };
  const ordered = <T extends {id: string}>(rows: T[]) => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const taskRows = ordered(tasks.filter(row => row.project_id === projectId).map(row => ({
    id: text(row.id), revision: revision(row.revision), status: text(row.status), due_date: text(row.due_date),
    video_id: text(row.video_id), editor_email: text(row.editor_email), reviewer_email: text(row.reviewer_email),
  })));
  const videoRows = ordered(videos.filter(row => row.project_id === projectId).map(row => ({
    id: text(row.id), revision: revision(row.revision), due_date: text(row.due_date),
  })));
  const bytes = sha256(new TextEncoder().encode(JSON.stringify([projectId, taskRows, videoRows])));
  return {token: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""), tasks: taskRows, videos: videoRows};
}

export function projectDeadlineTargets(snapshot: ProjectDeadlineSnapshot) {
  const tasks = snapshot.tasks.filter(task => !deadlineTaskClosed(task.status));
  const videoIds = new Set(tasks.map(task => task.video_id));
  return {tasks, videos: snapshot.videos.filter(video => videoIds.has(video.id))};
}
