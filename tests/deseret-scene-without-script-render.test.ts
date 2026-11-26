// Renders the two real scene entry points in jsdom. Neither asks for a scene script any more:
// - the Deseret production panel's scene editor (also embedded in the native QC window), whose commands go
//   through the real integration service;
// - the native production workspace's storyboard submission, which saves video and duration as a draft before an explicit batch submission.
// A workspace draft saved by the previous version (with a script) restores safely without sending its text. Its
// local script text is kept byte for byte in that draft until it is submitted or cleared, and never carried into
// another task's draft. An unconfirmed request saved by the previous version is still re-sent byte for byte.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import type { ComponentType } from "react";
import type { DeseretIntegrationState, DeseretScene } from "../lib/deseret-workspace";
import { productionDraftKey } from "../lib/production-drafts";
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
// jsdom has no modal dialogs; a local stub keeps the workspace dialog open as a browser would.
Object.assign(window.HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  close(this: HTMLDialogElement) { this.removeAttribute("open"); },
});
// Never inspect DOM nodes in assertion messages: a failed deep comparison walks React's fiber graph.

let React: typeof import("react");
let ReactDOM: typeof import("react-dom/client");
let act: typeof import("react").act;
let Panel: ComponentType<{ projectId: string; taskId?: string; locale: "en" | "zh" }>;
let Workspace: ComponentType<{ locale: "zh" | "en"; email: string; handovers: Row[]; languages: Row[]; refresh: () => void }>;
let openProductionWorkspace: typeof import("../app/ProductionWorkspace.tsx").openProductionWorkspace;
const realFetch = globalThis.fetch;
before(async () => {
  React = await import("react");
  ReactDOM = await import("react-dom/client");
  act = React.act;
  Panel = (await import("../app/DeseretProductionPanel.tsx")).default;
  const workspace = await import("../app/ProductionWorkspace.tsx");
  Workspace = workspace.default;
  openProductionWorkspace = workspace.openProductionWorkspace;
});
after(() => { globalThis.fetch = realFetch; window.close(); });

const HISTORICAL_SCRIPT = "Historical scene script kept inside AIGC.";
const historical: DeseretScene = { id: "scene-1", order: 1, version: 1, duration: 30, script: HISTORICAL_SCRIPT, characterIds: [], voiceId: "", fileVersionId: "file-scene-v1", languageTaskId: "task-1" };
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
/** Sets a form control's value the way a user does, so React's change handlers run. */
async function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new window.Event(element instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
async function mount(node: ReturnType<typeof React.createElement>) {
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = ReactDOM.createRoot(host);
  await act(async () => { root.render(node); });
  await settle();
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

for (const locale of ["zh", "en"] as const) it(`disables final publication and explains outstanding QC (${locale})`, async () => {
  const h = createHarness({ ...finalReviewState(), stage: "final_production" });
  h.db.sqlite.prepare("UPDATE language_projects SET status='待质检' WHERE project_id=?").run(PROJECT);
  const workspace = await h.service.workspace(LEAD, PROJECT);
  globalThis.fetch = async () => Response.json(workspace);
  const {host, unmount} = await mount(React.createElement(Panel, { projectId: PROJECT, locale }));
  try {
    const reason = [...host.querySelectorAll(".deseret-action small")].find(el =>
      el.textContent?.includes(locale === "zh" ? "请先完成当前成片的质检" : "Complete internal QC"));
    assert.ok(reason);
    const button = reason.parentElement!.querySelector("button")!;
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-describedby"), reason.id);
  } finally { await unmount(); }
});

describe("Deseret production panel scene editor", () => {
  let h: Harness;
  const posts: Row[] = [];
  beforeEach(() => {
    const state: DeseretIntegrationState = { ...finalReviewState(), stage: "production", packages: [], scenes: [structuredClone(historical)], revisionSceneIds: [], revision: 3 };
    h = createHarness(state);
    h.db.sqlite.prepare("UPDATE language_projects SET status='制作中' WHERE project_id=?").run(PROJECT);
    for (const id of ["file-scene-v1", "file-new-scene"])
      h.addNative({ id, taskId: "task-1", directory: "03_项目制作", status: "pending_qc", name: `${id}.mp4`, mimeType: "video/mp4", size: 4096, sha256: "c".repeat(64) });
    posts.length = 0;
    // Reads and commands go through the real integration service as MAKER.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
      if (url.pathname !== "/api/deseret-book" || url.searchParams.get("project") !== PROJECT) return new Response(null, { status: 404 });
      if (init?.method !== "POST") return Response.json(JSON.parse(JSON.stringify(await h.service.workspace(MAKER, PROJECT))));
      const body = JSON.parse(String(init.body)) as Row;
      posts.push(body);
      return Response.json(JSON.parse(JSON.stringify(await h.service.command(MAKER, PROJECT, body))));
    }) as typeof fetch;
  });

  for (const locale of ["zh", "en"] as const) it(`has no script field or script prompt and saves video and duration only (${locale})`, async () => {
    const { host, unmount } = await mount(React.createElement(Panel, { projectId: PROJECT, taskId: "task-1", locale }));
    try {
      const form = host.querySelector(".deseret-scene-form")!;
      assert.ok(form, "the scene editor is shown");
      assert.ok(!form.querySelector("textarea"), "no script field");
      assert.doesNotMatch(form.textContent!, /脚本|script/i);
      const [sceneSelect, fileSelect] = [...form.querySelectorAll("select.select-native")] as HTMLSelectElement[];
      await setValue(fileSelect, "file-new-scene");
      await setValue(form.querySelector("input[type=number]") as HTMLInputElement, "12.5");
      assert.ok(!form.querySelector("[role=status]"), "no reason blocks saving");
      const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
      assert.equal(submit.disabled, false);
      await click(submit);
      await settle();
      const scene = (posts[0].payload as { scene: Row }).scene;
      assert.equal(Object.hasOwn(scene, "script"), false, JSON.stringify(scene));
      assert.deepEqual([scene.duration, scene.fileVersionId], [12.5, "file-new-scene"]);
      const saved = h.state().scenes.find(item => item.id === scene.id)!;
      assert.equal(Object.hasOwn(saved, "script"), false);
      // Editing the historical scene without a script keeps its stored text and its version.
      await setValue(sceneSelect, "scene-1");
      assert.ok(!form.querySelector("textarea"));
      await click(form.querySelector("button[type=submit]")!);
      await settle();
      assert.equal(Object.hasOwn((posts[1].payload as { scene: Row }).scene, "script"), false);
      assert.deepEqual(h.state().scenes.find(item => item.id === "scene-1"), historical);
      // The historical script stays visible inside AIGC; a scene without one shows no empty script block.
      const cards = [...host.querySelectorAll(".deseret-production-scene")];
      assert.deepEqual(cards.map(card => card.querySelector(".deseret-production-script")?.textContent ?? null), [HISTORICAL_SCRIPT, null]);
    } finally { await unmount(); }
  });
});

describe("Native production workspace storyboard submission", () => {
  const TASK = "task-1", OTHER_TASK = "task-3";
  const sceneFile = { id: "file-new-scene", name: "scene.mp4", mimeType: "video/mp4", size: 4096, kind: "video", category: "03.preview", currentVersionId: "file-new-scene", status: "available" };
  const posts: Row[] = [];
  function workspaceData(status: string, extra: Row = {}, taskId = TASK) {
    return { deseret: { stage: "production", intake: "accepted", materials: "ready", revision: 3, publishedFinalVersionIds: [], scenes: [historical] },
      task: { id: taskId, status, revision: 5, production_progress: 40, reviewer_email: QC, editor_email: MAKER, project_name: "Book trailer", language: "English" },
      files: [sceneFile], libraryFiles: [], documents: [], staged: [], handovers: [], members: [], finals: [], finalFiles: [], checkpoints: [], checkpointFiles: [], ...extra };
  }
  function serve(data: Row) {
    posts.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
      if (url.pathname === "/api/production-workspace" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Response.json({ ok: true, submissionId: "s", finalVersionId: sceneFile.id }); }
      if (url.pathname === "/api/production-workspace" && url.searchParams.get("task") === TASK && !url.searchParams.has("upload")) return Response.json(data);
      if (url.pathname === "/api/production-workspace" && url.searchParams.get("task") === OTHER_TASK) return Response.json(workspaceData("制作中", {}, OTHER_TASK));
      return Response.json({ error: "not used" }, { status: 404 });
    }) as typeof fetch;
  }
  /** A final draft as the previous version saved it, including the scene script it used to require. */
  function previousDraft(extra: Row = {}) {
    window.localStorage.setItem(productionDraftKey(MAKER, TASK, "final"), JSON.stringify({ at: Date.now(), percent: "100", note: "", selected: [sceneFile.id], categories: {},
      finalId: sceneFile.id, sceneDraft: { id: "scene-new", version: 0, script: OLD_SCRIPT, duration: "12" }, context: { mode: "final" }, pending: null, ...extra }));
  }
  const OLD_SCRIPT = "Old draft script text";
  /** The scene draft currently stored for a task's final form. */
  const storedScene = (taskId = TASK) => (JSON.parse(window.localStorage.getItem(productionDraftKey(MAKER, taskId, "final")) ?? "null") as { sceneDraft?: Row } | null)?.sceneDraft;
  async function open() {
    const view = await mount(React.createElement(Workspace, { locale: "zh", email: MAKER, handovers: [], languages: [], refresh: () => {} }));
    await act(async () => { openProductionWorkspace(TASK, "final"); });
    await settle();
    return view;
  }
  function button(host: Element, label: string) {
    const match = [...host.querySelectorAll("button")].find(item => item.textContent === label);
    assert.ok(match, label);
    return match;
  }
  const saveDraft = (host: Element) => button(host, "保存分镜草稿");
  beforeEach(() => { window.localStorage.clear(); });

  it("saves video and duration as a draft, then sends a batch only after a separate confirmation", async () => {
    const data = workspaceData("制作中");
    serve(data);
    previousDraft();
    const { host, unmount } = await open();
    try {
      const section = host.querySelector(".production-handover")!;
      assert.ok(section);
      assert.ok(!section.querySelector("textarea"));
      assert.doesNotMatch(host.textContent!, /分镜脚本|Scene script/);
      assert.equal((section.querySelector("input[type=number]") as HTMLInputElement).value, "12");
      assert.equal(button(host, "提交质检").disabled, true);
      // The next workspace read comes from the server with both this draft and one saved on an earlier day.
      Object.assign(data.deseret, { drafts: [
        {sceneId:"earlier",fileVersionId:"old-file",duration:4,sceneVersion:0,name:"Earlier.mp4"},
        {sceneId:"scene-new",fileVersionId:sceneFile.id,duration:12,sceneVersion:0,name:"scene.mp4"}
      ] });
      await click(saveDraft(host)); await settle();
      assert.deepEqual(posts.map(body=>body.kind),["storyboard_draft"]);
      assert.deepEqual([posts[0].sceneId,posts[0].fileVersionId,posts[0].duration],["scene-new",sceneFile.id,"12"]);
      assert.ok(!JSON.stringify(posts).includes(OLD_SCRIPT));
      assert.match(host.textContent!, /Earlier.mp4/);
      await click(button(host,"提交质检"));
      assert.match(host.textContent!, /确认将这 2 个分镜送质检/);
      assert.equal(posts.length,1);
      await click(button(host,"继续编辑"));
      assert.equal(posts.length,1);
      await click(button(host,"提交质检"));
      await click(button(host,"确认提交质检")); await settle();
      assert.deepEqual(posts.map(body=>body.kind),["storyboard_draft","storyboard_submit"]);
      assert.equal(posts[1].materialsConfirmed,"true");
    } finally { await unmount(); }
  });

  it("uploads a local scene as production material, then saves its draft without notifying QC", async () => {
    const data = workspaceData("制作中");
    serve(data);
    let upload: Record<string,string> = {};
    const original = Object.getOwnPropertyDescriptor(globalThis,"XMLHttpRequest");
    class UploadRequest {
      upload = {};
      status = 200;
      responseText = "";
      onload = () => {};
      open() {}
      setRequestHeader() {}
      send(form: FormData) {
        upload = Object.fromEntries(["id","purpose","category","task"].map(key=>[key,String(form.get(key))]));
        this.responseText = JSON.stringify({file:{id:upload.id,name:"first.mp4",mimeType:"video/mp4",kind:"video",size:4,staged:true,purpose:upload.purpose,category:upload.category}});
        this.onload();
      }
    }
    Object.defineProperty(globalThis,"XMLHttpRequest",{value:UploadRequest,configurable:true});
    const {host,unmount} = await open();
    try {
      const input = host.querySelector(".storyboard-batch input[type=file]")!;
      Object.defineProperty(input,"files",{value:[new File(["test"],"first.mp4",{type:"video/mp4"})],configurable:true});
      await act(async()=>{input.dispatchEvent(new window.Event("change",{bubbles:true}));});
      await click(button(host,"上传视频")); await settle();
      assert.equal(upload.purpose,"materials");
      assert.equal(upload.category,"video");
      assert.equal(upload.task,TASK);
      assert.equal(posts.length,0);
      await setValue(host.querySelector(".production-handover input[type=number]") as HTMLInputElement,"8");
      assert.equal(saveDraft(host).disabled,false);
      await click(saveDraft(host)); await settle();
      assert.deepEqual(posts.map(body=>[body.kind,body.fileVersionId]),[["storyboard_draft",upload.id]]);
    } finally {
      await unmount();
      if (original) Object.defineProperty(globalThis,"XMLHttpRequest",original);
      else Reflect.deleteProperty(globalThis,"XMLHttpRequest");
    }
  });

  it("keeps the old draft's local script text after opening and after a duration change, until a successful submission", async () => {
    serve(workspaceData("制作中"));
    previousDraft();
    const { host, unmount } = await open();
    try {
      assert.deepEqual(storedScene(), { id: "scene-new", version: 0, duration: "12", script: OLD_SCRIPT }, "opening keeps the text");
      await setValue(host.querySelector(".production-handover input[type=number]") as HTMLInputElement, "15");
      await settle();
      assert.deepEqual(storedScene(), { id: "scene-new", version: 0, duration: "15", script: OLD_SCRIPT }, "a duration change keeps the text");
      await click(saveDraft(host));
      await settle();
      assert.equal(posts[0].duration,"15");
      assert.ok(!JSON.stringify(posts).includes(OLD_SCRIPT));
      assert.ok(!JSON.stringify(window.localStorage).includes(OLD_SCRIPT), "the submitted draft is gone with its text");
    } finally { await unmount(); }
  });

  it("keeps a draft that holds nothing but an old script", async () => {
    serve(workspaceData("制作中"));
    previousDraft({ percent: "40", selected: [], finalId: "", sceneDraft: { id: "scene-new", version: 0, script: OLD_SCRIPT, duration: "" } });
    const { unmount } = await open();
    try {
      assert.deepEqual(storedScene(), { id: "scene-new", version: 0, duration: "", script: OLD_SCRIPT });
    } finally { await unmount(); }
  });

  it("drops the old text when the user clears the draft, and never carries it into another task", async () => {
    serve(workspaceData("制作中"));
    previousDraft();
    const { host, unmount } = await open();
    try {
      await act(async () => { openProductionWorkspace(OTHER_TASK, "final"); });
      await settle();
      await setValue(host.querySelector(".production-handover input[type=number]") as HTMLInputElement, "20");
      await settle();
      assert.ok(storedScene(OTHER_TASK), "the other task has its own draft");
      assert.ok(!Object.hasOwn(storedScene(OTHER_TASK)!, "script"), JSON.stringify(storedScene(OTHER_TASK)));
      assert.equal(storedScene()?.script, OLD_SCRIPT, "the original task's draft still holds its text");
      await act(async () => { openProductionWorkspace(TASK, "final"); });
      await settle();
      const button = (label: string) => [...host.querySelectorAll("button")].find(item => item.textContent === label)!;
      await click(button("清空当前编辑"));
      await settle();
      assert.ok(!JSON.stringify(window.localStorage).includes(OLD_SCRIPT), "clearing the draft drops the text");
    } finally { await unmount(); }
  });

  it("still blocks submission without a valid duration", async () => {
    serve(workspaceData("制作中"));
    previousDraft();
    const { host, unmount } = await open();
    try {
      await setValue(host.querySelector(".production-handover input[type=number]") as HTMLInputElement, "0");
      assert.equal(saveDraft(host).disabled, true);
    } finally { await unmount(); }
  });

  it("shows submitted scenes read-only during QC", async () => {
    serve(workspaceData("待质检"));
    const {host,unmount} = await open();
    try {
      assert.match(host.textContent!, /分镜进度/);
      assert.ok(!host.querySelector(".storyboard-batch fieldset"));
      assert.ok(![...host.querySelectorAll("button")].some(b => b.textContent === "确认提交质检"));
    } finally { await unmount(); }
  });

  it("allows a saved replacement to go to QC while a different returned scene is still in production", async () => {
    const data = workspaceData("质检驳回");
    Object.assign(data.deseret, {
      scenes: [
        {...historical,id:"a",order:1,qualityStatus:"qc_approved"},
        {...historical,id:"b",order:2,qualityStatus:"rejected"},
        {...historical,id:"c",order:3,qualityStatus:"rejected"},
      ],
      drafts:[{sceneId:"c",fileVersionId:sceneFile.id,duration:8,sceneVersion:1,name:"C-v2.mp4"}]
    });
    serve(data);
    const {host,unmount} = await open();
    try {
      const options = [...host.querySelector<HTMLSelectElement>(".production-handover select")!.options];
      assert.deepEqual(options.map(option=>option.value),["","b","c"]);
      assert.equal(button(host,"提交质检").disabled,false);
      await click(button(host,"提交质检")); await click(button(host,"确认提交质检")); await settle();
      assert.deepEqual(posts.map(body=>body.kind),["storyboard_submit"]);
    } finally {await unmount();}
  });

  it("re-sends an unconfirmed request saved by the previous version byte for byte", async () => {
    serve(workspaceData("制作中"));
    const pending = { submissionId: "00000000-0000-4000-8000-000000000001", languageProjectId: TASK, kind: "final", note: "Old note", percent: "100",
      deseretScene: JSON.stringify({ id: "scene-new", version: 0, script: "Old script", duration: 12 }), finalVersionId: sceneFile.id, fileIds: JSON.stringify([sceneFile.id]) };
    previousDraft({ pending });
    const { host, unmount } = await open();
    try {
      await click(button(host,"核对本次提交结果"));
      await settle();
      assert.deepEqual(posts, [pending]);
    } finally { await unmount(); }
  });
});
