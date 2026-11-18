import { isConfirmedCustomerImport } from "./customer-import-result";
import { submissionTicket } from "./submission-client";
import { directTransferEnabled, directUpload, pauseDirectUploads } from "./direct-upload-client";
import { releaseVideoBuffers } from "./video-buffer-client";
import { releaseMediaCovers } from "./media-cover-session";
/** A second factor for this workbench tab, never an account identity supplied by the UI. */
const proofKey = "lifewood-tab-proof-v2";
let proof = "";
let restore = false;
let previousProof = "";
let previousProofs: string[] = [];
const restoreChainKey = "lifewood-tab-restore-chain-v1";
export function prepareTabSession() {
  if (proof) return;
  try {
    const navigation = window.performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
    const old = window.sessionStorage.getItem(proofKey) ?? "";
    restore = navigation?.type === "reload" && /^[a-f0-9]{64}$/.test(old);
    if (restore) {
      const chain = JSON.parse(window.sessionStorage.getItem(restoreChainKey) || "[]");
      previousProofs = [...new Set([old, ...(Array.isArray(chain) ? chain : [])])].filter(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)).slice(0, 3);
      previousProof = old;
    }
  } catch { /* Storage is optional: a fresh page will require a password. */ }
  if (!proof) proof = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  try {
    window.sessionStorage.setItem(proofKey, proof);
    window.sessionStorage.setItem(restoreChainKey, JSON.stringify([proof, ...previousProofs].slice(0, 3)));
  } catch { /* Refresh will require signing in again. */ }
}
export function mayRestoreTabSession() { return restore; }
export function tabRestoreHeaders(): Record<string, string> { return restore && previousProof ? { "x-lifewood-restore": previousProof } : {}; }
export function tabRestoreHeaderOptions(): Record<string, string>[] {
  return restore && previousProofs.length ? previousProofs.map(value => ({ "x-lifewood-restore": value })) : [tabRestoreHeaders()];
}
export function stopTabRestore() { restore = false; previousProof = ""; }
export function confirmTabSession() {
  previousProofs = [];
  try { window.sessionStorage.setItem(restoreChainKey, JSON.stringify([proof])); } catch { /* Optional reload recovery. */ }
}
/** A successful logout ends the old page identity, including late requests. */
export function resetTabSession() {
  pauseDirectUploads();
  releaseVideoBuffers();
  releaseMediaCovers();
  stopTabRestore();
  try { window.sessionStorage.removeItem("lifewood-handover-dismissed"); } catch { /* UI-only reminder state. */ }
  proof = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  try { window.sessionStorage.setItem(proofKey, proof); } catch { /* Memory identity remains usable. */ }
  confirmTabSession();
}
export function tabHeaders() { return proof ? { "x-lifewood-tab": proof } : {}; }
const closeOutboxKey = "lifewood-closed-tab-v1";
/** Only written when an owner actually closes; never a copy of a live owner's proof. */
export async function flushClosingTab() {
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(closeOutboxKey); } catch { return; }
  if (!saved) return;
  try {
    const item = JSON.parse(saved) as { tabProof: string; proofs?: string[]; at: number };
    if (/^[a-f0-9]{64}$/.test(item.tabProof) && Date.now() - item.at < 30 * 60_000) {
      const signal = AbortSignal.timeout(5000);
      const candidates = [...new Set([item.tabProof, ...(Array.isArray(item.proofs) ? item.proofs : [])])].filter(value => /^[a-f0-9]{64}$/.test(value)).slice(0, 3);
      for (const candidate of candidates) {
        const result = await globalThis.fetch("/api/session-close", { method: "POST", credentials: "same-origin", cache: "no-store",
          signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ tabProof: candidate }) });
        if (result.status === 204) {
          // Give an ordinary reload its server-side grace before a fresh login.
          await new Promise(resolve => setTimeout(resolve, 2000));
          break;
        }
        if (result.status !== 401) throw Error("CLOSE_UNCONFIRMED");
      }
    }
    if (window.localStorage.getItem(closeOutboxKey) === saved) window.localStorage.removeItem(closeOutboxKey);
  } catch (error) { if (error instanceof SyntaxError) window.localStorage.removeItem(closeOutboxKey); else throw error; }
}
/** Beacon survives ordinary page closure; authentication is checked in the route. */
export function releaseClosingTab() {
  if (!proof) return;
  const body = JSON.stringify({ tabProof: proof });
  try { window.localStorage.setItem(closeOutboxKey, JSON.stringify({ tabProof: proof, proofs: previousProofs, at: Date.now() })); } catch { /* Beacon remains available. */ }
  try {
    if (navigator.sendBeacon?.("/api/session-close", new Blob([body], { type: "application/json" }))) return;
  } catch { /* Fall back to a bounded keepalive request. */ }
  void globalThis.fetch("/api/session-close", { method: "POST", credentials: "same-origin", keepalive: true,
    headers: { "content-type": "application/json" }, body }).catch(() => {});
}
export async function workspaceFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  if (typeof window === "undefined") return globalThis.fetch(input, init);
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
  if (directTransferEnabled() && url.origin===window.location.origin && ["/api/files","/api/request-documents","/api/production-workspace"].includes(url.pathname) && init.method==="POST" && init.body instanceof FormData) {
    return directUpload(url.pathname as "/api/files"|"/api/request-documents"|"/api/production-workspace",init.body,workspaceFetch,undefined,init.signal);
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  // Never leak the proof to an upload provider or any other external URL.
  if (url.origin === window.location.origin && url.pathname.startsWith("/api/") && proof) headers.set("x-lifewood-tab", proof);
  const ticket = url.origin === window.location.origin && url.pathname === "/api/workflow" && init.method === "POST"
    ? await submissionTicket(init.body) : null;
  if (ticket) headers.set("x-lifewood-submission", ticket.id);
  const response = await globalThis.fetch(input, { ...init, headers });
  if(url.origin===window.location.origin&&response.status===401){releaseVideoBuffers();releaseMediaCovers("unauthorized");}
  if (ticket && response.ok) {
    try {
      const result = await response.clone().json() as { error?: string } | null;
      const sent = typeof init.body === "string" ? JSON.parse(init.body) as { action?: string; payload?: { rows?: string } } : null;
      const importRows = sent?.action === "client.import" ? JSON.parse(sent.payload?.rows || "null") as { sourceRow?: string | number }[] | null : null;
      const expectedRows = Array.isArray(importRows) ? importRows.map((row, index) => Number(row?.sourceRow ?? index + 2)) : undefined;
      if (!init.signal?.aborted && response.status !== 202 && result && !result.error && (sent?.action !== "client.import" || expectedRows && isConfirmedCustomerImport(result, expectedRows))) ticket.complete();
    } catch { /* Unknown body = unknown result. Retain the same request ID. */ }
  }
  return response;
}
