"use client";
import { useEffect, useRef } from "react";
import { workspaceFetch } from "../lib/tab-session";

/** Sends only connection/activity flags, never keys typed, text or page contents. */
export function useAccountPresence(email: string, uploading: boolean) {
  const uploadRef = useRef(uploading);
  useEffect(() => { uploadRef.current = uploading; }, [uploading]);
  useEffect(() => {
    let alive = true, busy = false, ended = false, activity = 1, sent = 0, lastAttempt = 0;
    const controller = new AbortController();
    const pulse = async () => {
      if (!alive || ended || busy || !navigator.onLine || Date.now() - lastAttempt < 10_000) return;
      busy = true; lastAttempt = Date.now();
      const revision = activity;
      const media = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio")).some(item => !item.paused && !item.ended);
      try {
        const response = await workspaceFetch("/api/presence", {
          method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ active: revision !== sent || uploadRef.current || media, visible: document.visibilityState === "visible" }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (response.ok) sent = revision;
        if (response.status === 401 || response.status === 403) ended = true;
      } catch { /* Missing heartbeats become unconfirmed, never automatic logout/takeover. */ }
      finally { busy = false; }
    };
    const mark = () => { activity++; };
    const visibility = () => { if (document.visibilityState === "visible") activity++; void pulse(); };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    // Capture also sees non-bubbling scroll events inside tables and dialogs.
    events.forEach(event => window.addEventListener(event, mark, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    void pulse();
    const timer = window.setInterval(() => { void pulse(); }, 30_000);
    return () => {
      alive = false; controller.abort(); window.clearInterval(timer);
      events.forEach(event => window.removeEventListener(event, mark, true));
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
    };
  }, [email]);
}
