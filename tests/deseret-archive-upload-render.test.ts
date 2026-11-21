// The native production workspace's Deseret archive mode: the scene/final submission dialog offers a shortcut, and
// the archive form commits files through the existing formal save as kind "archive" with the chosen engineering
// file, optional preview and next steps. It stays open while the task awaits QC. Daily reports are untouched.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import type { ComponentType } from "react";
import { productionDraftKey } from "../lib/production-drafts";
import { MAKER, QC, type Row } from "./support/deseret-harness";

register("./support/tsx-load.mjs", import.meta.url);
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis };
};
const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://aigc.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"])
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : (window as unknown as Row)[key] });
(globalThis as Row).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window.HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  close(this: HTMLDialogElement) { this.removeAttribute("open"); },
});

let React: typeof import("react");
let ReactDOM: typeof import("react-dom/client");
let Workspace: ComponentType<{ locale: "zh" | "en"; email: string; handovers: Row[]; languages: Row[]; refresh: () => void }>;
let open: typeof import("../app/ProductionWorkspace.tsx").openProductionWorkspace;
const realFetch = globalThis.fetch;
before(async () => {
  React = await import("react");
  ReactDOM = await import("react-dom/client");
  ({ default: Workspace, openProductionWorkspace: open } = await import("../app/ProductionWorkspace.tsx"));
});
after(() => { globalThis.fetch = realFetch; window.close(); });

const TASK = "task-1";
const engineering = { id: "eng-1", name: "trailer.prproj", mimeType: "application/octet-stream", size: 10, kind: "project", category: "03.project", currentVersionId: "eng-1", status: "available" };
const preview = { id: "prev-1", name: "preview.mp4", mimeType: "video/mp4", size: 10, kind: "video", category: "03.preview", currentVersionId: "prev-1", status: "available" };
const posts: Row[] = [];
const listed: string[] = [];
function serve(status: string) {
  posts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    if (url.pathname === "/api/direct-uploads") { listed.push(url.search); return Response.json({ uploads: [] }); }
    if (url.pathname === "/api/production-workspace" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Response.json({ ok: true, archiveId: "archive-1" }); }
    if (url.pathname === "/api/production-workspace" && url.searchParams.get("task") === TASK) return Response.json({
      deseret: { stage: "production", intake: "accepted", materials: "ready", revision: 3, publishedFinalVersionIds: [], scenes: [] },
      task: { id: TASK, status, revision: 5, production_progress: 40, reviewer_email: QC, editor_email: MAKER, project_name: "Book trailer", language: "English" },
      files: [engineering, preview], libraryFiles: [{ ...engineering, library: true, id: "library", name: "library.prproj" }], documents: [], staged: [{ ...preview, id: "staged-1", name: "new-preview.mp4", currentVersionId: undefined, staged: true, category: "video", purpose: "archive" }], handovers: [], members: [], finals: [], finalFiles: [], checkpoints: [], checkpointFiles: [] });
    return Response.json({ error: "not used" }, { status: 404 });
  }) as typeof fetch;
}
const { act } = await import("react");
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function setValue(element: HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new window.Event(element instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function mount() {
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = ReactDOM.createRoot(host);
  await act(async () => { root.render(React.createElement(Workspace, { locale: "zh", email: MAKER, handovers: [], languages: [], refresh: () => {} })); });
  await settle();
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const primary = (host: Element) => host.querySelector("footer .primary-button") as HTMLButtonElement;
beforeEach(() => window.localStorage.clear());

describe("native archive upload", () => {
  it("lists unfinished uploads of the archive form under the archive purpose", async () => {
    serve("待质检");
    const meta = window.document.createElement("meta");
    meta.name = "lifewood-file-transfer"; meta.content = "direct";
    window.document.head.append(meta);
    listed.length = 0;
    const { unmount } = await mount();
    try {
      await act(async () => { open(TASK, "materials", undefined, undefined, undefined, { archive: true }); });
      await settle();
      const queries = listed.map(search => new URLSearchParams(search)).filter(query => query.get("task") === TASK);
      assert.ok(queries.length, "the unfinished list was requested");
      assert.ok(queries.every(query => query.get("purpose") === "archive"), queries.map(query => query.toString()).join(" | "));
    } finally { await unmount(); meta.remove(); }
  });

  it("offers the archive shortcut in the scene submission dialog", async () => {
    serve("制作中");
    const { host, unmount } = await mount();
    try {
      await act(async () => { open(TASK, "final"); });
      await settle();
      const shortcut = [...host.querySelectorAll("button")].find(item => /登记内部留档/.test(item.textContent ?? ""));
      assert.ok(shortcut, "shortcut shown");
      await act(async () => { (shortcut as HTMLElement).click(); });
      await settle();
      assert.ok(host.querySelector("[data-section='archive-upload']"), "the archive form opened");
    } finally { await unmount(); }
  });

  it("saves selected files as an archive while the task awaits QC, with the engineering file, preview and next steps", async () => {
    serve("待质检");
    // Files chosen in this form (restored from its own local draft); the engineering file is filed under Project files.
    window.localStorage.setItem(productionDraftKey(MAKER, TASK, "materials", "archive"), JSON.stringify({ at: Date.now(), note: "", percent: "40",
      selected: ["eng-1", "prev-1"], categories: { "eng-1": "project", "prev-1": "video" }, context: { mode: "materials" }, pending: null }));
    const { host, unmount } = await mount();
    try {
      await act(async () => { open(TASK, "materials", undefined, undefined, undefined, { archive: true }); });
      await settle();
      const form = host.querySelector("[data-section='archive-upload']")!;
      assert.ok(form, "archive form shown");
      assert.equal(primary(host).disabled, true, "the engineering file must be chosen");
      const [projectSelect, previewSelect] = [...form.querySelectorAll("select")] as HTMLSelectElement[];
      await setValue(projectSelect, "eng-1");
      await setValue(previewSelect, "prev-1");
      await setValue(form.querySelector("textarea") as HTMLTextAreaElement, "Continue from scene 9");
      assert.equal(primary(host).disabled, false, "open while awaiting QC");
      await act(async () => { primary(host).click(); });
      await settle();
      assert.deepEqual([posts[0].kind, posts[0].archiveProjectVersionId, posts[0].archivePreviewVersionId, posts[0].nextSteps, posts[0].fileIds],
        ["archive", "eng-1", "prev-1", "Continue from scene 9", JSON.stringify(["eng-1", "prev-1"])]);
      assert.match(host.textContent ?? "", /内部留档/);
    } finally { await unmount(); }
  });

  it("recovers an unresolved archive from a daily form and replays its original request", async () => {
    serve("待质检");
    const pending = { submissionId: "receipt-1", kind: "archive", languageProjectId: TASK,
      archiveProjectVersionId: "eng-1", archivePreviewVersionId: "prev-1", fileIds: '["eng-1","prev-1"]' };
    window.localStorage.setItem(productionDraftKey(MAKER, TASK, "materials", "archive"), JSON.stringify({
      at: Date.now(), note: "", selected: ["eng-1", "prev-1"], categories: { "eng-1": "project", "prev-1": "video" },
      context: { mode: "materials" }, pending }));
    const { host, unmount } = await mount();
    try {
      await act(async () => { open(TASK, "daily"); });
      await settle();
      assert.ok(host.querySelector("[data-section='archive-upload']"), "unresolved archive takes priority");
      assert.match(primary(host).textContent ?? "", /核对本次提交结果/);
      await act(async () => { primary(host).click(); });
      await settle();
      assert.deepEqual(posts, [pending]);
    } finally { await unmount(); }
  });

  it("retains the submission id when a POST response is lost and the editor reopens a different form", async () => {
    serve("待质检");
    const server = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await server(input, init);
      if (init?.method === "POST" && posts.length === 1) throw new TypeError("Lost response");
      return response;
    };
    window.localStorage.setItem(productionDraftKey(MAKER, TASK, "materials", "archive"), JSON.stringify({
      at: Date.now(), note: "", selected: ["eng-1"], categories: { "eng-1": "project" },
      context: { mode: "materials" }, percent: "40" }));
    let view = await mount();
    try {
      await act(async () => { open(TASK, "materials", undefined, undefined, undefined, { archive: true }); });
      await settle();
      await setValue(view.host.querySelector("[data-section='archive-upload'] select")!, "eng-1");
      await act(async () => { primary(view.host).click(); });
      await settle();
      assert.equal(posts.length, 1);
      await view.unmount();
      view = await mount();
      await act(async () => { open(TASK, "final"); });
      await settle();
      assert.match(primary(view.host).textContent ?? "", /核对本次提交结果/);
      await act(async () => { primary(view.host).click(); });
      await settle();
      assert.deepEqual(posts[1], posts[0]);
    } finally { await view.unmount(); }
  });

  it("mixes saved task files and staged files and restores the unsubmitted role choices", async () => {
    serve("待质检");
    let view = await mount();
    const openArchive = async () => {
      await act(async () => { open(TASK, "materials", undefined, undefined, undefined, { archive: true }); });
      await settle();
    };
    try {
      await openArchive();
      const choose = [...view.host.querySelectorAll("button")].find(b => /选择已.*文件/.test(b.textContent ?? ""))!;
      await act(async () => { choose.click(); });
      await settle();
      const cards = [...view.host.querySelectorAll(".production-file-grid article")];
      for (const name of [engineering.name, "new-preview.mp4"]) {
        const card = cards.find(c => c.textContent?.includes(name));
        assert.ok(card, `picker offers ${name}`);
        const pick = card.querySelector("button[aria-pressed]") as HTMLButtonElement;
        await act(async () => { pick.click(); });
      }
      assert.ok(cards.every(c => !c.textContent?.includes("library.prproj")));
      await act(async () => { primary(view.host).click(); });
      const selects = () => [...view.host.querySelectorAll<HTMLSelectElement>("[data-section='archive-upload'] select")];
      await setValue(selects()[0], "eng-1");
      await setValue(selects()[1], "staged-1");
      await view.unmount();
      view = await mount();
      await openArchive();
      assert.deepEqual(selects().map(select => select.value), ["eng-1", "staged-1"]);
      await act(async () => { primary(view.host).click(); });
      await settle();
      assert.deepEqual([posts[0]?.archiveProjectVersionId, posts[0]?.archivePreviewVersionId], ["eng-1", "staged-1"]);
    } finally { await view.unmount(); }
  });

  it("offers as engineering file only a saved version that really is in Project files, whatever the form category", async () => {
    serve("制作中");
    window.localStorage.setItem(productionDraftKey(MAKER, TASK, "materials", "archive"), JSON.stringify({ at: Date.now(), note: "", percent: "40",
      selected: ["eng-1", "prev-1"], categories: { "eng-1": "project", "prev-1": "project" }, context: { mode: "materials" }, pending: null }));
    const { host, unmount } = await mount();
    try {
      await act(async () => { open(TASK, "materials", undefined, undefined, undefined, { archive: true }); });
      await settle();
      const [projectSelect] = [...host.querySelector("[data-section='archive-upload']")!.querySelectorAll("select")] as HTMLSelectElement[];
      assert.deepEqual([...projectSelect.options].map(option => option.value).filter(Boolean), ["eng-1"], "a preview reclassified in the form is not offered");
      await setValue(projectSelect, "prev-1");
      assert.equal(primary(host).disabled, true);
    } finally { await unmount(); }
  });
});
