"use client";
// Cover-sized media for lists and cards (players keep DirectFileMedia).
//
// - Work starts only near the viewport. Page-wide slots bound it: four cover
//   image reads and one video decode at a time. Signing, decoding and image
//   reads each have an application deadline. Cancelling a cover stops its
//   media before its read/decode slot is reused. An already started signature
//   keeps its separate signing slot until it completes or reaches its deadline.
// - A decoded frame is copied to a small canvas and the video is torn down.
//   Shared frames and the canvases showing them count against one byte
//   budget. Covers that leave the viewport release their copy; unshown
//   frames are kept briefly and evicted first when space is needed.
// - Frames are tied to the page session (lib/media-cover-session). Logout, an
//   account change or a 401 drops them and discards late answers. A frame is
//   shown again without asking the server only while the signed read that
//   produced it is still valid; after that the server is asked again, and a
//   denial clears every cover of that file. Proxy-mode reads have no signature
//   to bound reuse, so their frames are never retained.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { directTransferEnabled, validateSignedTransferUrl } from "../lib/direct-upload-client";
import { coverSessionEpoch, onCoverSessionReset } from "../lib/media-cover-session";
import {MediaSlots,frameGrabSlots} from '../lib/media-slots';
export {MediaSlots,frameGrabSlots} from '../lib/media-slots';

/** Application limits. Tests may shorten the timings; production uses these values. */
export const mediaCoverLimits = {
  visibilityMs: 150,
  signMs: 10000,
  retryMs: 1500,
  grabMs: 20000,
  readMs: 20000,
  retainMs: 60000,
  budgetBytes: 24 * 1024 ** 2,
  maxEdge: 960,
  minEdge: 48,
};

const signedSource = (src: string) => /^\/api\/(?:files|request-documents|production-workspace|public-file)\?/.test(src);

/** Bounded FIFO slots; a waiter cancelled before it starts never runs. A priority waiter (a cover the user opened) queues first but never exceeds the limit. */
export const coverReadSlots = new MediaSlots(4);
const coverSignSlots = new MediaSlots(4);

// ---- authorization -------------------------------------------------------
type Access = { kind: "ok"; url: string; expiresAt: number } | { kind: "missing" } | { kind: "denied" } | { kind: "error" };
type PendingAccess = { promise: Promise<Access>; controller: AbortController; waiters: number };
const accessRequests = new Map<string, PendingAccess>();
const activeSignRequests = new Set<AbortController>();
const sessionKey = (src: string) => `${coverSessionEpoch()}\n${src}`;

/**
 * One authorization request per object and session at a time. Queue waiting
 * and the actual request each have a `signMs` deadline. A cancelled queued
 * request never starts. An already started
 * authorization retains its slot until it finishes or times out, even if
 * its covers leave: aborting fetch does not cancel the server's DB work.
 * A returning cover can join that work. Only a 2xx answer with a valid
 * storage URL is "ok"; "missing" is the server's not-yet-generated thumbnail
 * answer; any other refusal is "denied"; timeouts and network failures are
 * "error". Nothing is kept after the request settles.
 */
export function coverAccess(src: string, signal: AbortSignal): Promise<Access> {
  if (signal.aborted) return Promise.resolve({ kind: "error" });
  if (!directTransferEnabled() || !signedSource(src)) return Promise.resolve({ kind: "ok", url: src, expiresAt: Number.POSITIVE_INFINITY });
  const epoch = coverSessionEpoch(), key = sessionKey(src);
  let pending = accessRequests.get(key);
  if (pending?.controller.signal.aborted) { accessRequests.delete(key); pending = undefined; }
  if (!pending) {
    const controller = new AbortController();
    let deadline = window.setTimeout(() => controller.abort(), mediaCoverLimits.signMs);
    const promise = (async (): Promise<Access> => {
      let release: (() => void) | undefined;
      try {
        release = await coverSignSlots.acquire(controller.signal);
        window.clearTimeout(deadline);
        if (controller.signal.aborted) return { kind: "error" };
        deadline = window.setTimeout(() => controller.abort(), mediaCoverLimits.signMs);
        activeSignRequests.add(controller);
        const requestedAt = Date.now();
        const url = new URL(src, window.location.href); url.searchParams.set("access", "1");
        // Settles on abort even if the network layer does not honour the signal.
        const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
        const response = await Promise.race([workspaceFetch(url.pathname + url.search, { cache: "no-store", signal: controller.signal }), aborted]);
        const body = await Promise.race([response.json().catch(() => ({})), aborted]) as { url?: unknown; expiresAt?: unknown; error?: unknown; code?: unknown };
        if (!response.ok) return body.code === "PREVIEW_NOT_GENERATED" || body.error === "The video preview has not been generated yet." ? { kind: "missing" } : { kind: "denied" };
        if (typeof body.url !== "string" || typeof body.expiresAt !== "number") return { kind: "error" };
        const serverDate = Date.parse(response.headers.get("date") || "");
        const expiresAt = Number.isFinite(serverDate) ? requestedAt + body.expiresAt - serverDate - 1000 : body.expiresAt;
        return { kind: "ok", url: validateSignedTransferUrl(body.url), expiresAt };
      } catch { return { kind: "error" }; }
      finally { activeSignRequests.delete(controller); window.clearTimeout(deadline); release?.(); }
    })();
    pending = { promise, controller, waiters: 0 };
    const entry = pending;
    accessRequests.set(key, entry);
    void promise.finally(() => { if (accessRequests.get(key) === entry) accessRequests.delete(key); });
  }
  const entry = pending;
  entry.waiters++;
  return new Promise(resolve => {
    let settled = false;
    const leave = () => {
      if (settled) return; settled = true;
      if (--entry.waiters === 0 && !activeSignRequests.has(entry.controller)) {
        if (accessRequests.get(key) === entry) accessRequests.delete(key);
        entry.controller.abort();
      }
      resolve({ kind: "error" });
    };
    if (signal.aborted) return leave();
    signal.addEventListener("abort", leave, { once: true });
    void entry.promise.then(result => {
      if (settled) return; settled = true;
      entry.waiters--; signal.removeEventListener("abort", leave);
      resolve(epoch === coverSessionEpoch() ? result : { kind: "error" });
    });
  });
}

// One recovery attempt per mounted file/session. Backoff holds no media slot.
// Leaving the viewport, unmounting or resetting the session cancels the timer.
function useSignRecovery(near: boolean, restart: () => void) {
  const used = useRef(false), timer = useRef<number | undefined>(undefined);
  const callback = useRef(restart);
  useEffect(() => { callback.current = restart; });
  const clear = useCallback(() => { window.clearTimeout(timer.current); timer.current = undefined; }, []);
  useEffect(() => { if (!near) clear(); return clear; }, [near, clear]);
  useEffect(() => onCoverSessionReset(() => { clear(); used.current = false; }), [clear]);
  return () => {
    if (!near || used.current) return false;
    used.current = true;
    const epoch = coverSessionEpoch();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (epoch === coverSessionEpoch()) callback.current();
    }, mediaCoverLimits.retryMs);
    return true;
  };
}

// ---- frames and budget ---------------------------------------------------
type Frame = { canvas: HTMLCanvasElement; bytes: number; validUntil: number; users: number; touched: number; timer: number };
type CoverEvent = { type: "reset"; unauthorized: boolean } | { type: "purge"; src: string } | { type: "change" } | { type: "space" };
const frames = new Map<string, Frame>();
const displays = new Map<object, number>();
const grabs = new Map<string, object>();
const listeners = new Set<(event: CoverEvent) => void>();
const emit = (event: CoverEvent) => { for (const listener of [...listeners]) listener(event); };
const frameBytes = () => { let bytes = 0; for (const frame of frames.values()) bytes += frame.bytes; return bytes; };
const displayBytes = () => { let bytes = 0; for (const value of displays.values()) bytes += value; return bytes; };
const usedBytes = () => frameBytes() + displayBytes();

function dropFrame(key: string, frame: Frame) {
  if (frames.get(key) !== frame) return;
  window.clearTimeout(frame.timer);
  frame.canvas.width = 0; frame.canvas.height = 0;
  frames.delete(key);
  emit({ type: "space" });
}
/** Evicts unshown frames, oldest first, until `needed` more bytes fit the budget. */
function makeRoom(needed: number) {
  if (usedBytes() + needed <= mediaCoverLimits.budgetBytes) return true;
  for (const [key, frame] of [...frames].filter(([, value]) => value.users === 0).sort((a, b) => a[1].touched - b[1].touched)) {
    dropFrame(key, frame);
    if (usedBytes() + needed <= mediaCoverLimits.budgetBytes) return true;
  }
  return usedBytes() + needed <= mediaCoverLimits.budgetBytes;
}
function purgeSource(src: string) {
  for (const [key, frame] of [...frames]) if (key.endsWith(`\n${src}`)) { frame.users = 0; dropFrame(key, frame); }
  emit({ type: "purge", src });
}
onCoverSessionReset(reason => {
  for (const pending of accessRequests.values()) pending.controller.abort();
  accessRequests.clear();
  for (const [key, frame] of [...frames]) { frame.users = 0; dropFrame(key, frame); }
  grabs.clear();
  emit({ type: "reset", unauthorized: reason === "unauthorized" });
});

/** Application-held cover pixels and work in progress; counts only, never URLs. Browser decoder memory is not visible here. */
export function mediaCoverStats() {
  let inUse = 0;
  for (const frame of frames.values()) if (frame.users > 0) inUse++;
  return { reads: coverReadSlots.running, readsWaiting: coverReadSlots.waiting, frameGrabs: frameGrabSlots.running, frameGrabsWaiting: frameGrabSlots.waiting, signing: accessRequests.size, frames: frames.size, framesInUse: inUse, frameBytes: frameBytes(), displayBytes: displayBytes(), totalBytes: usedBytes(), budgetBytes: mediaCoverLimits.budgetBytes };
}

/**
 * Registers an already decoded frame (for example the poster a library
 * generation produced but could not store) so a FrameCover can show it
 * without reading the video again. It still needs a fresh authorization.
 */
export async function adoptCoverFrame(src: string, blob: Blob) {
  const epoch = coverSessionEpoch(), key = sessionKey(src);
  if (!directTransferEnabled() || frames.has(key) || typeof window.createImageBitmap !== "function") return false;
  try {
    const bitmap = await window.createImageBitmap(blob);
    const scale = Math.min(1, mediaCoverLimits.maxEdge / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    if (epoch !== coverSessionEpoch() || frames.has(key) || !makeRoom(width * height * 4)) { bitmap.close(); return false; }
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return false; }
    context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
    frames.set(key, { canvas, bytes: width * height * 4, validUntil: 0, users: 0, touched: Date.now(), timer: 0 });
    emit({ type: "change" });
    return true;
  } catch { return false; }
}

// ---- viewport ------------------------------------------------------------
/** True while the element is within `margin` of the viewport. */
export function useNearViewport(node: Element | null, margin = "240px") {
  // Without IntersectionObserver every cover counts as near; the slots still bound concurrency.
  const [near, setNear] = useState(() => typeof window !== "undefined" && typeof window.IntersectionObserver !== "function");
  useEffect(() => {
    if (!node || typeof window.IntersectionObserver !== "function") return;
    let timer: number | undefined;
    const observer = new window.IntersectionObserver(entries => {
      for (const entry of entries) {
        window.clearTimeout(timer);
        if (!entry.isIntersecting) setNear(false);
        else if (mediaCoverLimits.visibilityMs <= 0) setNear(true);
        else timer = window.setTimeout(() => setNear(true), mediaCoverLimits.visibilityMs);
      }
    }, { rootMargin: margin });
    observer.observe(node);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, [node, margin]);
  return near;
}

function stopVideo(node: HTMLVideoElement | null) {
  if (!node) return;
  try { node.pause(); node.removeAttribute("src"); node.load(); } catch { /* Element already detached or unsupported. */ }
}

// ---- frame cover ---------------------------------------------------------
type FrameCoverProps = { src: string; className?: string; label?: string; priority?: boolean; seek: (duration: number) => number; onUnavailable: () => void };
type FrameJob = {
  done: boolean; controller: AbortController; key: string; epoch: number;
  release: (() => void) | null; claimed: boolean; deadline: number; access: Access | null; renewed: boolean; display: Frame | null;
};

/** Shows one paused frame. Changing `src` starts over: nothing of the old file survives. */
export function FrameCover(props: FrameCoverProps) {
  return <FrameCoverForFile key={props.src} {...props} />;
}

function FrameCoverForFile({ src, className, label, priority = false, seek, onUnavailable }: FrameCoverProps) {
  const [node, setNode] = useState<Element | null>(null);
  const near = useNearViewport(node);
  const [view, setView] = useState<"empty" | "video" | "frame" | "fallback">("empty");
  const [videoUrl, setVideoUrl] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const recoverSign = useSignRecovery(near, () => setAttempt(value => value + 1));
  const [paint, setPaint] = useState(0);
  const [gone, setGone] = useState(false);
  const [token] = useState(() => ({}));
  const canvas = useRef<HTMLCanvasElement | null>(null), video = useRef<HTMLVideoElement | null>(null);
  // A cover waits either for another cover's grab of the same file, or for budget space of a known size.
  const job = useRef<FrameJob | null>(null), waiting = useRef<{ for: "grab" } | { for: "space"; bytes: number } | null>(null);
  const report = useRef(onUnavailable), seekRef = useRef(seek);
  useEffect(() => { report.current = onUnavailable; seekRef.current = seek; });

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    // React clears refs before effect cleanup, so stop the old node here.
    if (video.current && video.current !== element) stopVideo(video.current);
    video.current = element;
    if (element) {
      // StrictMode replays refs on the same DOM node without rewriting src.
      const current = job.current;
      if (!element.hasAttribute("src") && current && !current.done && current.access?.kind === "ok") element.src = current.access.url;
      setNode(element);
    }
  }, []);
  const attachCanvas = useCallback((element: HTMLCanvasElement | null) => {
    if (canvas.current && canvas.current !== element) { canvas.current.width = 0; canvas.current.height = 0; }
    canvas.current = element;
    if (element) {
      // Reattaching after StrictMode ref cleanup must restore the display copy.
      const current = job.current, source = current?.display?.canvas;
      if (source && !current.done) {
        element.width = source.width; element.height = source.height;
        try { element.getContext("2d")?.drawImage(source, 0, 0); } catch { /* Canvas unavailable. */ }
      }
      setNode(element);
    }
  }, []);
  const releaseDisplay = (current: FrameJob) => {
    const frame = current.display;
    if (!frame) return;
    current.display = null;
    displays.delete(token);
    if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
    frame.users = Math.max(0, frame.users - 1); frame.touched = Date.now();
    if (frame.users === 0) {
      const key = [...frames].find(([, value]) => value === frame)?.[0];
      // Retention is bounded by budget and time and never extends authorization; proxy reads are not retained.
      if (key && Number.isFinite(frame.validUntil)) frame.timer = window.setTimeout(() => { if (frame.users === 0) dropFrame(key, frame); }, mediaCoverLimits.retainMs);
      else if (key) dropFrame(key, frame);
    }
    emit({ type: "space" });
  };
  const endGrab = (current: FrameJob) => {
    window.clearTimeout(current.deadline);
    if (current.release) { current.release(); current.release = null; }
    if (current.claimed) { current.claimed = false; if (grabs.get(current.key) === token) grabs.delete(current.key); emit({ type: "change" }); }
  };
  const cancel = (current: FrameJob | null) => {
    if (!current || current.done) return;
    current.done = true;
    current.controller.abort();
    stopVideo(video.current);
    setVideoUrl(undefined); setView("empty");
    endGrab(current);
    releaseDisplay(current);
  };
  const giveUp = (current: FrameJob) => { cancel(current); setVideoUrl(undefined); setView("empty"); setGone(true); report.current(); };
  const signFailed = (current: FrameJob) => {
    if (recoverSign()) cancel(current);
    else giveUp(current);
  };
  const show = (current: FrameJob, frame: Frame) => {
    // Pin the selected frame while making room for its display copy.
    // Otherwise the eviction pass can remove this very cache hit.
    frame.users++;
    if (!makeRoom(frame.bytes)) { frame.users--; return false; }
    frame.touched = Date.now(); window.clearTimeout(frame.timer);
    displays.set(token, frame.bytes); current.display = frame;
    setView("frame");
    setPaint(value => value + 1);
    return true;
  };

  useEffect(() => {
    const unsubscribe = (() => {
      const listener = (event: CoverEvent) => {
        const current = job.current;
        if (event.type === "reset") {
          cancel(current); setVideoUrl(undefined); setView("empty");
          setGone(event.unauthorized);
          if (!event.unauthorized) setAttempt(value => value + 1);
        }
        else if (event.type === "purge" && event.src === src) { if (current && !current.done) giveUp(current); else { setView("empty"); setGone(true); report.current(); } }
        else if (event.type === "change" && waiting.current?.for === "grab") setAttempt(value => value + 1);
        else if (event.type === "space" && waiting.current?.for === "space" && mediaCoverLimits.budgetBytes - usedBytes() >= waiting.current.bytes) setAttempt(value => value + 1);
      };
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    })();
    return unsubscribe;
  // `cancel`/`giveUp` only touch refs and setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (!near || gone) return;
    const current: FrameJob = { done: false, controller: new AbortController(), key: sessionKey(src), epoch: coverSessionEpoch(), release: null, claimed: false, deadline: 0, access: null, renewed: false, display: null };
    job.current = current; waiting.current = null;
    const live = () => !current.done && job.current === current && current.epoch === coverSessionEpoch();
    void (async () => {
      const cached = frames.get(current.key);
      if (cached) {
        if (Date.now() >= cached.validUntil) {
          const access = await coverAccess(src, current.controller.signal);
          if (!live()) return;
          if (access.kind === "denied") { purgeSource(src); return; }
          if (access.kind === "error") return signFailed(current);
          if (access.kind !== "ok") return giveUp(current);
          cached.validUntil = access.expiresAt;
        }
        if (frames.get(current.key) !== cached) { setAttempt(value => value + 1); return; }
        if (!show(current, cached)) waiting.current = { for: "space", bytes: cached.bytes };
        return;
      }
      if (grabs.has(current.key)) { waiting.current = { for: "grab" }; return; }
      grabs.set(current.key, token); current.claimed = true;
      let release: () => void;
      try { release = await frameGrabSlots.acquire(current.controller.signal, priority); }
      catch { return; }
      if (!live()) { release(); return; }
      current.release = release;
      // One deadline covers signing and decoding; on expiry the request is aborted and the video stopped.
      current.deadline = window.setTimeout(() => { if (live()) { if (!current.access) signFailed(current); else giveUp(current); } }, mediaCoverLimits.grabMs);
      const access = await coverAccess(src, current.controller.signal);
      if (!live()) return;
      if (access.kind === "error") return signFailed(current);
      if (access.kind !== "ok") { if (access.kind === "denied") { endGrab(current); purgeSource(src); return; } return giveUp(current); }
      current.access = access;
      setVideoUrl(access.url); setView("video");
    })();
    return () => cancel(current);
  // `show`, `cancel` and `giveUp` only touch refs and setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, gone, attempt, src, priority]);

  useEffect(() => {
    const current = job.current, target = canvas.current, source = current?.display?.canvas;
    if (view !== "frame" || !source || !target) return;
    target.width = source.width; target.height = source.height;
    try { target.getContext("2d")?.drawImage(source, 0, 0); } catch { /* Canvas unavailable. */ }
  }, [view, paint]);

  const capture = (current: FrameJob, element: HTMLVideoElement) => {
    if (current.done || !current.claimed || job.current !== current) return;
    const width = element.videoWidth, height = element.videoHeight;
    const shown = Math.max(element.clientWidth, element.clientHeight, 120) * Math.min(window.devicePixelRatio || 1, 2);
    const full = Math.min(1, Math.min(mediaCoverLimits.maxEdge, Math.max(160, shown)) / Math.max(width, height, 1));
    const wanted = Math.max(1, Math.round(width * full)) * Math.max(1, Math.round(height * full)) * 8;
    let w = Math.max(1, Math.round(width * full)), h = Math.max(1, Math.round(height * full));
    // The shared frame and this cover's copy are both counted; under pressure the frame is made smaller to fit.
    if (!makeRoom(w * h * 8)) {
      const room = mediaCoverLimits.budgetBytes - usedBytes();
      const scale = room > 0 ? full * Math.sqrt(room / (w * h * 8)) : 0;
      w = Math.floor(width * scale); h = Math.floor(height * scale);
      if (Math.max(w, h) < mediaCoverLimits.minEdge || w < 1 || h < 1) {
        // Budget is held by covers on screen: stop reading and wait until this frame fits, instead of exceeding it.
        stopVideo(element); setVideoUrl(undefined); setView("empty"); endGrab(current); current.done = true;
        waiting.current = { for: "space", bytes: Math.min(wanted, mediaCoverLimits.budgetBytes) };
        return;
      }
    }
    const copy = document.createElement("canvas");
    let context: CanvasRenderingContext2D | null = null;
    try { context = width && height ? copy.getContext("2d") : null; } catch { context = null; }
    if (!context) { endGrab(current); setView("fallback"); return; }
    copy.width = w; copy.height = h;
    context.drawImage(element, 0, 0, w, h);
    stopVideo(element); setVideoUrl(undefined);
    const access = current.access, frame: Frame = { canvas: copy, bytes: w * h * 4, validUntil: access?.kind === "ok" ? access.expiresAt : 0, users: 0, touched: Date.now(), timer: 0 };
    if (current.epoch !== coverSessionEpoch()) { copy.width = 0; return; }
    frames.set(current.key, frame);
    endGrab(current);
    show(current, frame);
  };
  const presented = (current: FrameJob, element: HTMLVideoElement) => {
    if (current.done) return;
    if (element.readyState < 2) { element.addEventListener("loadeddata", () => presented(current, element), { once: true }); return; }
    const frameVideo = element as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    let fired = false;
    const go = () => { if (fired) return; fired = true; if (video.current === element) capture(current, element); };
    window.setTimeout(go, 350);
    if (frameVideo.requestVideoFrameCallback) frameVideo.requestVideoFrameCallback(go);
    else window.requestAnimationFrame(() => window.requestAnimationFrame(go));
  };
  const videoError = (event: SyntheticEvent<HTMLVideoElement>) => {
    const current = job.current;
    if (!current || current.done) return;
    const access = current.access;
    if (access?.kind === "ok" && !current.renewed && Date.now() >= access.expiresAt - 2000) {
      current.renewed = true;
      void coverAccess(src, current.controller.signal).then(next => {
        if (current.done || job.current !== current) return;
        if (next.kind === "ok") { current.access = next; setVideoUrl(next.url); }
        else if (next.kind === "denied") { endGrab(current); purgeSource(src); }
        else if (next.kind === "error") signFailed(current);
        else giveUp(current);
      });
      return;
    }
    stopVideo(event.currentTarget);
    giveUp(current);
  };

  if (view === "video" || view === "fallback") return <video ref={attachVideo} className={className} src={videoUrl} crossOrigin={videoUrl?.startsWith("https://") ? "anonymous" : undefined} muted playsInline preload="metadata" tabIndex={-1} aria-label={label} aria-hidden={label ? undefined : true} data-cover-state={view}
    onLoadedMetadata={event => {
      const current = job.current, element = event.currentTarget;
      if (view !== "video" || !current || current.done) return;
      const target = Number.isFinite(element.duration) && element.duration > 0 ? seekRef.current(element.duration) : 0;
      if (target > 0 && element.currentTime !== target) { element.addEventListener("seeked", () => presented(current, element), { once: true }); element.currentTime = target; }
      else presented(current, element);
    }}
    onError={videoError} />;
  return <canvas ref={attachCanvas} className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-cover-state={view === "frame" ? "ready" : "waiting"} />;
}

// ---- cover image ---------------------------------------------------------
type CoverImageProps = { src: string; className?: string; alt?: string; onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void; onFault: () => void; onDenied: () => void };
type ReadJob = { done: boolean; controller: AbortController; release: (() => void) | null; deadline: number; expiresAt: number; renewed: boolean; url: string };

/** A stored thumbnail or small original image read through the shared slots. Changing `src` starts over. */
export function CoverImage(props: CoverImageProps) {
  return <CoverImageForFile key={props.src} {...props} />;
}

function CoverImageForFile({ src, className, alt = "", onLoad, onFault, onDenied }: CoverImageProps) {
  const [node, setNode] = useState<Element | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const attachImage = useCallback((element: HTMLImageElement | null) => {
    if (image.current && image.current !== element) image.current.removeAttribute("src");
    image.current = element;
    if (element) setNode(element);
  }, []);
  const near = useNearViewport(node);
  const [url, setUrl] = useState<string | undefined>();
  const [state, setState] = useState<"waiting" | "loading" | "ready" | "failed">("waiting");
  const [attempt, setAttempt] = useState(0);
  const recoverSign = useSignRecovery(near, () => setAttempt(value => value + 1));
  const job = useRef<ReadJob | null>(null);
  const handlers = useRef({ onFault, onDenied, onLoad });
  useEffect(() => { handlers.current = { onFault, onDenied, onLoad }; });

  const finish = (current: ReadJob, keepImage = false) => {
    if (current.done) return false;
    current.done = true;
    window.clearTimeout(current.deadline);
    current.controller.abort();
    if (!keepImage && image.current?.getAttribute("src") === current.url) image.current.removeAttribute("src");
    if (current.release) { current.release(); current.release = null; }
    return true;
  };
  const fail = (current: ReadJob, kind: "fault" | "unavailable") => {
    if (!finish(current)) return;
    setUrl(undefined); setState("failed");
    if (kind === "fault") handlers.current.onFault(); else handlers.current.onDenied();
  };
  const signFailed = (current: ReadJob) => {
    if (current.done) return;
    if (!recoverSign()) return fail(current, "unavailable");
    finish(current); setUrl(undefined); setState("waiting");
  };

  useEffect(() => onCoverSessionReset(reason => {
    const current = job.current;
    if (current && !current.done) finish(current);
    job.current = null; setUrl(undefined);
    setState(reason === "unauthorized" ? "failed" : "waiting");
    if (reason !== "unauthorized") setAttempt(value => value + 1);
  }), []);

  useEffect(() => {
    if (!near || state !== "waiting") return;
    const current: ReadJob = { done: false, controller: new AbortController(), release: null, deadline: 0, expiresAt: 0, renewed: false, url: "" };
    job.current = current;
    void (async () => {
      let release: () => void;
      try { release = await coverReadSlots.acquire(current.controller.signal); }
      catch { return; }
      if (current.done) { release(); return; }
      current.release = release;
      // One deadline covers signing and the image read; on expiry the source is removed before the slot is reused.
      current.deadline = window.setTimeout(() => { if (current.url) fail(current, "fault"); else signFailed(current); }, mediaCoverLimits.readMs);
      const access = await coverAccess(src, current.controller.signal);
      if (current.done) return;
      if (access.kind === "error") return signFailed(current);
      if (access.kind === "ok") { current.expiresAt = access.expiresAt; current.url = access.url; setUrl(access.url); setState("loading"); return; }
      fail(current, access.kind === "missing" ? "fault" : "unavailable");
    })();
    return () => { if (state === "waiting" && !current.url) finish(current); };
  // `fail`/`finish` only touch refs and setters; `state` gates the start.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, src, attempt]);

  // Leaving the page or the file ends any unfinished read.
  useEffect(() => () => { const current = job.current; if (current) finish(current); }, []);

  const own = (event: SyntheticEvent<HTMLImageElement>) => {
    const current = job.current;
    return current && !current.done && current.url && event.currentTarget.getAttribute("src") === current.url ? current : null;
  };
  // Private signed reads cannot use the Next.js image optimiser.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={attachImage} className={className} alt={url ? alt : ""} src={url} crossOrigin={url?.startsWith("https://") ? "anonymous" : undefined} decoding="async" data-cover-state={state}
    onLoad={event => { const current = own(event); if (!current) return; finish(current, true); setState("ready"); handlers.current.onLoad?.(event); }}
    onError={event => {
      const current = own(event);
      if (!current) return;
      if (!current.renewed && Date.now() >= current.expiresAt - 2000) {
        current.renewed = true;
        void coverAccess(src, current.controller.signal).then(next => {
          if (current.done || job.current !== current) return;
          if (next.kind === "ok") { current.expiresAt = next.expiresAt; current.url = next.url; setUrl(next.url); }
          else if (next.kind === "error") signFailed(current);
          else fail(current, next.kind === "missing" ? "fault" : "unavailable");
        });
        return;
      }
      fail(current, "fault");
    }} />;
}
