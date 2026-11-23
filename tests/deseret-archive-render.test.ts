// Exercises the producer and lead screens against the integration service, including historical records and handovers.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import type { ComponentType } from "react";
import { deseretHandoverStatements } from "../db/deseret-production-archive";
import type { DeseretIntegrationState, DeseretScene } from "../lib/deseret-workspace";
import { createHarness, finalReviewState, LEAD, MAKER, PROJECT, QC, type Harness, type Row } from "./support/deseret-harness";

register("./support/tsx-load.mjs", import.meta.url);
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis };
};
const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://aigc.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"])
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : (window as unknown as Row)[key] });
(globalThis as Row).IS_REACT_ACT_ENVIRONMENT = true;

let React: typeof import("react");
let ReactDOM: typeof import("react-dom/client");
let Panel: ComponentType<{ projectId: string; taskId?: string; locale: "en" | "zh" }>;
const realFetch = globalThis.fetch;
before(async () => {
  React = await import("react");
  ReactDOM = await import("react-dom/client");
  Panel = (await import("../app/DeseretProductionPanel.tsx")).default;
});
after(() => { globalThis.fetch = realFetch; window.close(); });

const scene = (id: string, order: number, taskId: string, fileVersionId: string): DeseretScene =>
  ({ id, order, version: 1, duration: 10, characterIds: [], voiceId: "", fileVersionId, languageTaskId: taskId });
let h: Harness;
const posts: Row[] = [];
function version(id: string, taskId: string, folderCode: string, mimeType = "application/octet-stream", createdBy = taskId === "task-2" ? "other-maker@example.test" : MAKER) {
  h.db.sqlite.prepare("INSERT OR IGNORE INTO aigc_folders (id,parent_folder_id,language_project_id,folder_code,deleted_at) VALUES (?,?,?,?,NULL)").run(`folder-${taskId}-${folderCode}`, `folder-${taskId}-03`, taskId, folderCode);
  h.addNative({ id, taskId, directory: "03_项目制作", status: "available", name: `${id}.bin`, mimeType, size: 10, sha256: "e".repeat(64), createdBy });
  h.db.sqlite.prepare("UPDATE aigc_files SET folder_id=? WHERE id=?").run(`folder-${taskId}-${folderCode}`, `logical-${id}`);
}
beforeEach(() => {
  const state: DeseretIntegrationState = { ...finalReviewState(), stage: "production", packages: [], revisionSceneIds: [], revision: 4,
    scenes: [scene("scene-a", 1, "task-1", "video-a"), scene("scene-b", 2, "task-2", "video-b")] };
  h = createHarness(state);
  h.db.sqlite.prepare("UPDATE language_projects SET status='制作中' WHERE project_id=?").run(PROJECT);
  h.db.sqlite.prepare("UPDATE language_projects SET language='Spanish' WHERE id='task-2'").run();
  for (const [id, task] of [["video-a", "task-1"], ["video-b", "task-2"]])
    h.addNative({ id, taskId: task, directory: "03_项目制作", status: "qc_approved", name: `${id}.mp4`, mimeType: "video/mp4", size: 4096, sha256: "c".repeat(64), qualityApproved: true });
  version("eng-1", "task-1", "03.project");
  version("eng-2", "task-2", "03.project");
  version("voice-1", "task-1", "03.voice", "audio/mpeg");
  posts.length = 0;
});
function serve(email: string) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    if (url.pathname !== "/api/deseret-book" || url.searchParams.get("project") !== PROJECT) return new Response(null, { status: 404 });
    if (init?.method !== "POST") return Response.json(JSON.parse(JSON.stringify(await h.service.workspace(email, PROJECT))));
    const body = JSON.parse(String(init.body)) as Row;
    posts.push(body);
    try { return Response.json(JSON.parse(JSON.stringify(await h.service.command(email, PROJECT, body)))); }
    catch (error) { return Response.json({ code: (error as { code?: string }).code }, { status: (error as { status?: number }).status ?? 400 }); }
  }) as typeof fetch;
}
const { act } = await import("react");
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new window.Event(element instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const click = async (element: Element | null | undefined) => { assert.ok(element, "element exists"); await act(async () => { (element as HTMLElement).click(); }); await settle(); };
async function mount(email: string, locale: "zh" | "en", taskId?: string) {
  serve(email);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = ReactDOM.createRoot(host);
  await act(async () => { root.render(React.createElement(Panel, { projectId: PROJECT, locale, ...(taskId ? { taskId } : {}) })); });
  await settle();
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const section = (host: Element) => host.querySelector("[data-section='deseret-archive']");
const button = (root: Element | null, text: RegExp) => [...(root?.querySelectorAll("button") ?? [])].find(item => text.test(item.textContent ?? ""));
describe("historical archives and handovers", () => {
  it("shows no archive entry on a new production task", async () => {
    const { host, unmount } = await mount(MAKER, "zh", "task-1");
    try {
      assert.equal(section(host), null);
      assert.equal(button(host, /上传工程文件|保存留档/), undefined);
    } finally { await unmount(); }
  });

  it("opens the exact live versions of the incoming editor's pinned archive", async () => {
    h.db.sqlite.prepare("UPDATE aigc_file_versions SET created_by='former@example.test' WHERE id IN ('eng-1','voice-1')").run();
    const archive = await h.service.command(LEAD, PROJECT, { requestId: "register-pinned", action: "archive.register", payload: { taskId: "task-1",
      projectVersionId: "eng-1", previewVersionId: "video-a", materialVersionIds: ["voice-1"] }, expectedRevision: h.state().revision });
    const pinned = archive.archives!.find(item => item.taskId === "task-1")!;
    for (const statement of (await deseretHandoverStatements(h.db, { handoverId: "pinned", projectId: PROJECT, taskId: "task-1",
      kind: "emergency", fromEmail: "former@example.test", toEmail: MAKER, now: "2026-11-20", archiveId: pinned.id })).statements) await statement.run();
    h.db.sqlite.prepare("UPDATE project_files SET deleted_at='2026-11-21' WHERE id='voice-1'").run();
    const { host, unmount } = await mount(MAKER, "en", "task-1");
    try {
      const target = host.querySelector("[data-handover='pinned'] a")?.getAttribute("href");
      assert.ok(target && target.startsWith("#"), "handover links to its exact archive");
      const card = window.document.getElementById(decodeURIComponent(target.slice(1)))!;
      assert.equal(card.getAttribute("data-archive-number"), String(pinned.number));
      const links = [...card.querySelectorAll("a[href]")].map(a => new URL(a.getAttribute("href")!, window.location.href));
      assert.deepEqual(links.filter(url => url.searchParams.get("download") === "1").map(url => url.searchParams.get("id")).sort(), ["eng-1", "video-a"]);
      assert.ok(links.some(url => url.searchParams.get("id") === "video-a" && !url.searchParams.has("download")));
      assert.ok(links.every(url => url.pathname === "/api/files" && url.searchParams.get("directOnly") === "1"));
    } finally { await unmount(); }
  });

  it("shows the assigned editor task work without a manual archive selection", async () => {
    h.db.sqlite.prepare("INSERT INTO language_assignment_history VALUES (?,?,?,?,?)").run("change", "task-1", "former@example.test", MAKER, "2026-11-21");
    const { host, unmount } = await mount(MAKER, "zh", "task-1");
    try {
      const list = [...host.querySelectorAll("details")].find(el => el.querySelector("summary")?.textContent?.includes("接手任务的文件"));
      assert.ok(list);
      assert.ok(list.querySelector('a[href*="id=eng-1"][href*="download=1"]'));
      assert.equal(list.querySelector('a[href*="id=eng-2"]'), null);
    } finally { await unmount(); }
  });

  it("shows nothing to a quality reviewer", async () => {
    const { host, unmount } = await mount(QC, "en", "task-1");
    try { assert.ok(!section(host)); assert.doesNotMatch(host.textContent ?? "", /Project archive/); }
    finally { await unmount(); }
  });
});

describe("publisher review without engineering files", () => {
  it("lets the lead publish quality-approved scenes without archive confirmations", async () => {
    const { host, unmount } = await mount(LEAD, "en");
    try {
      assert.equal(host.querySelector("[data-scene-confirm], [data-task-apply]"), null);
      const publish = button(host, /Publish for publisher review/)!;
      assert.equal(publish.disabled, false);
      await click(publish);
      const request = posts.at(-1)!;
      assert.equal(request.action, "package.publish");
      assert.deepEqual(request.payload, { phase: "storyboard" });
      assert.equal(h.state().stage, "storyboard_review");
    } finally { await unmount(); }
  });
});

describe("handover verification", () => {
  it("lets the incoming editor report missing work with a note (zh)", async () => {
    for (const statement of (await deseretHandoverStatements(h.db, { handoverId: "handover-1", projectId: PROJECT, taskId: "task-1", kind: "emergency", fromEmail: "former@example.test", toEmail: MAKER, now: "2026-11-20T08:00:00.000Z" })).statements) await statement.run();
    const { host, unmount } = await mount(MAKER, "zh");
    try {
      const card = host.querySelector("[data-handover='handover-1']");
      assert.ok(card, "the pending handover is shown");
      assert.match(card!.textContent ?? "", /待核验/);
      await setValue(card!.querySelector("textarea") as HTMLTextAreaElement, "工程无法打开，正在重建第 3–5 镜");
      await click(button(card, /登记缺项/));
      assert.deepEqual([posts.at(-1)!.action, posts.at(-1)!.payload], ["handover.verify", { handoverId: "handover-1", result: "missing", notes: "工程无法打开，正在重建第 3–5 镜" }]);
      assert.match(host.querySelector("[data-handover='handover-1']")?.textContent ?? "", /缺项/);
    } finally { await unmount(); }
  });
});
