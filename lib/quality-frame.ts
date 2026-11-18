/** Review points use the workbench's existing 25 fps frame convention. */
export function qualityFrameMatches(issue: {timeSeconds: number; endSeconds?: number}, currentTime: number, fps = 25) {
  if (![issue.timeSeconds, currentTime, fps].every(Number.isFinite) || issue.timeSeconds < 0 || currentTime < 0 || fps <= 0) return false;
  const current = Math.round(currentTime * fps), start = Math.round(issue.timeSeconds * fps);
  if (issue.endSeconds === undefined) return current === start;
  if (!Number.isFinite(issue.endSeconds) || issue.endSeconds < issue.timeSeconds) return false;
  return current >= start && current <= Math.round(issue.endSeconds * fps);
}
