"use client";
import { useLocalDraft } from "./useLocalDraft";

/** Strictly restore only this account/file/version's known review fields. */
export function useDeviceDraft<T>(key: string, empty: T) {
  const sanitize = (stored: unknown): T | null => {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
    const value = stored as Record<keyof T, unknown>;
    const restored = { ...empty };
    for (const name of Object.keys(empty as object) as Array<keyof T>) {
      const candidate = value[name];
      const original = empty[name];
      if (candidate === undefined) continue;
      if (Array.isArray(original)) {
        if (Array.isArray(candidate) && candidate.every(item => item && typeof item === "object" && typeof item.id === "string" && typeof item.description === "string" && typeof item.category === "string" && ["critical", "major", "minor"].includes(item.severity) && Number.isFinite(item.timeSeconds) && ["suggestion", "timecode", "endTimecode"].every(k => item[k] === undefined || typeof item[k] === "string") && (!item.position || ["x", "y", "width", "height"].every(k => Number.isFinite(item.position[k]) && item.position[k] >= 0 && item.position[k] <= 100)))) restored[name] = candidate as T[keyof T];
      } else if (original && typeof original === "object") {
        if (candidate && typeof candidate === "object" && Object.keys(original).every(k => ["unreviewed", "pass", "fail", "na"].includes((candidate as Record<string, string>)[k]))) restored[name] = candidate as T[keyof T];
      } else if (original === undefined) {
        if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) restored[name] = candidate as T[keyof T];
        else if (name === "pendingPosition" && candidate && ["x", "y", "width", "height"].every(k => Number.isFinite((candidate as Record<string, number>)[k]) && (candidate as Record<string, number>)[k] >= 0 && (candidate as Record<string, number>)[k] <= 100)) restored[name] = candidate as T[keyof T];
      } else if (typeof candidate === typeof original && (typeof candidate !== "number" || Number.isFinite(candidate))) restored[name] = candidate as T[keyof T];
    }
    const review = restored as Record<string, unknown>;
    if ("pendingPositionSeconds" in review && review.pendingPosition && review.pendingPositionSeconds === undefined) {
      // A legacy region can use only its own saved playhead, never a new task's time.
      const savedTime = (stored as Record<string, unknown>).currentTime;
      if (typeof savedTime === "number" && Number.isFinite(savedTime) && savedTime >= 0) review.pendingPositionSeconds = savedTime;
      else { review.pendingPosition = undefined; review.pendingRegionNeedsRedraw = true; }
    }
    return restored;
  };
  return useLocalDraft(key, empty, sanitize);
}
