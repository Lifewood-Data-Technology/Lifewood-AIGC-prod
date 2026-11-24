// Renders the real production panel in jsdom with a workspace projected by the real integration service, and checks
// that each final QA revision frame is offered by its exact type: PNG/JPEG as an image to view, MP4/MOV as a video to
// play, each with a download of the original under its own name. A copy whose stored type differs from the frame's
// is never previewed.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import type { ComponentType } from "react";
import { concludedEnvelope, createHarness, EXTERNAL, guidanceImage, MAKER, PROJECT, type Harness, type Row } from "./support/deseret-harness";

register("./support/tsx-load.mjs", import.meta.url);
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis };
};
// Previews are offered only on the direct file-transfer connection.
const { window } = new JSDOM('<!doctype html><html><head><meta name="lifewood-file-transfer" content="direct"></head><body></body></html>', { url: "https://aigc.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLMediaElement", "HTMLVideoElement", "Node", "Element", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : (window as unknown as Row)[key] });
(globalThis as Row).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom does not implement media loading.
for (const method of ["load", "pause"]) Object.defineProperty(window.HTMLMediaElement.prototype, method, { configurable: true, value() {} });

let React: typeof import("react");
let ReactDOM: typeof import("react-dom/client");
let Panel: ComponentType<{ projectId: string; locale: "en" | "zh" }>;
const realFetch = globalThis.fetch;
before(async () => {
  React = await import("react");
  ReactDOM = await import("react-dom/client");
  Panel = (await import("../app/DeseretProductionPanel.tsx")).default;
});
after(() => { globalThis.fetch = realFetch; window.close(); });

const media = (n: number, name: string, mimeType: string) => guidanceImage(n, { name, mimeType, objectKey: `aigc-guidance/${EXTERNAL}/guide-${n}-${name}` });
const png = media(1, "title.png", "image/png");
const mov = media(2, "grade.mov", "video/quicktime");
const mp4 = media(3, "cut.mp4", "video/mp4");
const relabelled = media(4, "logo.mp4", "video/mp4");
let h: Harness;
beforeEach(async () => {
  h = createHarness();
  const [envelope, raw] = concludedEnvelope({ actorId: "qa-reviewer-7", body: "Fix the listed issues.", sceneId: "final-task-1", issues: [
    { id: "iss-media", role: "creative", actorId: "cr-2", sceneId: "final-task-1", sceneVersion: 1, body: "See the references.",
      frames: [{ seconds: 1, caption: "Title", file: png }, { seconds: 2, file: mov }, { seconds: 3, file: mp4 }, { seconds: 4, file: relabelled }] },
  ] });
  assert.deepEqual(await h.service.receive(envelope, raw), { accepted: true, eventId: "evt-final-revision" });
  h.transferReady(png, "pkg-final-1", "task-1", "native-png");
  h.transferReady(mov, "pkg-final-1", "task-1", "native-mov");
  // mp4 is still transferring. The relabelled copy was stored as an image, so it is not previewed.
  h.addNative({ id: "native-relabelled", taskId: "task-1", directory: "02_客户素材", status: "available", name: "logo.mp4", mimeType: "image/png", size: relabelled.size, sha256: relabelled.sha256! });
  h.transferReady(relabelled, "pkg-final-1", "task-1", "native-relabelled");
});

/** Mounts the panel and returns each frame as [time label, preview kind, file label, download label]. */
async function frames(locale: "en" | "zh") {
  const workspace = JSON.parse(JSON.stringify(await h.service.workspace(MAKER, PROJECT)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    return url.pathname === "/api/deseret-book" && url.searchParams.get("project") === PROJECT ? Response.json(workspace) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = ReactDOM.createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Panel, { projectId: PROJECT, locale })));
    for (let attempt = 0; attempt < 50 && !host.querySelector(".deseret-revision-frame"); attempt++)
      await React.act(() => new Promise(resolve => setTimeout(resolve, 10)));
    return [...host.querySelectorAll(".deseret-revision-frame")].map(item => {
      const video = item.querySelector("video"), thumb = item.querySelector(".deseret-image-thumb");
      return [item.querySelector("small")?.textContent,
        video ? `video:${video.getAttribute("aria-label")}:${video.hasAttribute("controls")}` : thumb ? `image:${thumb.getAttribute("aria-label")}` : "none",
        item.querySelector(".brief-file-name")?.textContent, item.querySelector("button.icon-button")?.getAttribute("aria-label") ?? null];
    });
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
  }
}

describe("Final QA revision frames: view, play and download by exact type", () => {
  it("offers images to view and videos to play, each downloadable under its own name (English)", async () => {
    assert.deepEqual(await frames("en"), [
      ["Film time 1s · Title", "image:Enlarge image · title.png", "title.png", "Download title.png"],
      ["Film time 2s", "video:grade.mov:true", "grade.mov", "Download grade.mov"],
      ["Film time 3s", "none", "cut.mp4 · Awaiting file", null],
      ["Film time 4s", "none", "logo.mp4 · Currently unavailable", null],
    ]);
  });

  it("uses the same rules with Chinese labels", async () => {
    assert.deepEqual(await frames("zh"), [
      ["成片时间 1s · Title", "image:查看大图 · title.png", "title.png", "下载 title.png"],
      ["成片时间 2s", "video:grade.mov:true", "grade.mov", "下载 grade.mov"],
      ["成片时间 3s", "none", "cut.mp4 · 待接收", null],
      ["成片时间 4s", "none", "logo.mp4 · 暂不可用", null],
    ]);
  });
});
