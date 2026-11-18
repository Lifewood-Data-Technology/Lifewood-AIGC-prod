/** A work day uses the same Shanghai timezone as the existing progress display. */
export function reportDay(value: unknown = new Date().toISOString()): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
type Row = Record<string, unknown>;
export function reportDetails(row: Row): { workDate: string; stage: string } {
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(String(row.completeness_json || "{}")); } catch { /* Preserve legacy records without metadata. */ }
  return { workDate: typeof detail.workDate === "string" ? detail.workDate : reportDay(row.created_at), stage: String(detail.stage || "") };
}
export function validReportDate(value: string, today = reportDay()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value && value <= today;
}
/** Old snapshots remain immutable; group them by work date without rewriting IDs or file links. */
export function groupDailyReports(rows: Row[]) {
  const groups = new Map<string, { date: string; latest: Row; revisions: Row[] }>();
  for (const row of [...rows].sort((a, b) => Number(a.version_number) - Number(b.version_number))) {
    const date = reportDetails(row).workDate;
    if (!date) continue;
    const key = `${row.language_project_id}:${date}`;
    const group = groups.get(key) || { date, latest: row, revisions: [] };
    group.revisions.push(row);
    if (!["invalidated", "failed"].includes(String(row.status))) group.latest = row;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
}
export const reportStages = [
  ["script", "脚本与策划", "Script and planning"], ["assets", "素材整理", "Asset preparation"],
  ["rough", "粗剪", "Rough cut"], ["fine", "精剪与字幕", "Fine cut and subtitles"],
  ["audio", "配音与音频", "Voiceover and audio"], ["revision", "返修调整", "Revisions"],
  ["export", "成片导出", "Final export"],
] as const;
