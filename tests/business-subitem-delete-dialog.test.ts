// Renders the real permanent-delete dialog for one language version: shared content is listed and filterable,
// optional links can be ticked (none, some or all) while a required hand-over has no checkbox, and the submitted
// start request carries exactly the ticked links.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import type { ComponentType } from "react";

register("./support/tsx-load.mjs", import.meta.url);
type Row = Record<string, unknown>;
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis };
};
const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://aigc.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Node", "Element", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"])
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : (window as unknown as Row)[key] });
(globalThis as Row).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window.HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  close(this: HTMLDialogElement) { this.removeAttribute("open"); },
});

let React: typeof import("react");
let ReactDOM: typeof import("react-dom/client");
let Dialog: ComponentType<{ targets: { kind: string; id: string }[]; locale: "zh" | "en"; close: () => void; onDeleted: (ids: string[]) => void }>;
const realFetch = globalThis.fetch;
before(async () => {
  React = await import("react");
  ReactDOM = await import("react-dom/client");
  Dialog = (await import("../app/PermanentBusinessDeleteDialog.tsx")).default as never;
});
after(() => { globalThis.fetch = realFetch; window.close(); });

const target = { kind: "language", id: "t-en" };
const summary = { projects: 0, tasks: 1, records: 9, files: 2, objects: 1, retainedObjects: 1, reports: 1, quality: 1, deliveries: 0, handovers: 0 };
const listed = (items: unknown[]) => ({ items, total: items.length });
const preview = { target, name: "Video A · English", revision: 3, previewHash: "a".repeat(64), summary, availability: { enabled: true },
  disclosure: { files: listed([]), temporaryFiles: listed([]), pendingCleanups: listed([]), retained: listed([{ name: "en-shared.bin" }]),
    shared: listed([
      { id: "link:production_checkpoint_files:cpf-en-es", kind: "link", optional: true, name: "es-copy.bin", owner: "language", ownerName: "Spanish" },
      { id: "link:production_checkpoint_files:cpf-en-brief", kind: "link", optional: true, name: "brief.bin", owner: "language", ownerName: "Spanish" },
      { id: "kept:lf-en-eng", kind: "kept", optional: false, name: "en-eng.bin", owner: "language", ownerName: "Spanish" },
    ]) } };
const { act } = await import("react");
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new window.Event(element instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
const click = async (element: Element | null | undefined) => { assert.ok(element, "element exists"); await act(async () => { (element as HTMLElement).click(); }); await settle(); };

describe("permanent delete dialog for one language", () => {
  it("lists shared content with a filter, offers checkboxes only for optional links, and sends the ticked ones", async () => {
    const posts: Row[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
      if (url.pathname !== "/api/business-deletion") return Response.json({}, { status: 404 });
      if (init?.method !== "POST") return Response.json(preview);
      const body = JSON.parse(String(init.body)) as Row;
      posts.push(body);
      return Response.json({ id: body.submissionId, target, state: "complete", summary, completedObjects: 1, totalObjects: 1, errorCode: null });
    }) as typeof fetch;
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const root = ReactDOM.createRoot(host);
    await act(async () => { root.render(React.createElement(Dialog, { targets: [target], locale: "zh", close: () => {}, onDeleted: () => {} })); });
    await settle();
    try {
      const shared = host.querySelector("[data-section='shared']")!;
      assert.ok(shared, "shared content is listed");
      assert.equal(shared.querySelectorAll("input[type=checkbox]").length, 2, "only the two optional links can be ticked");
      assert.match(shared.querySelector("[data-shared='kept']")?.textContent ?? "", /移交给Spanish（必要，不可选）/);
      await setValue(shared.querySelector("select") as HTMLSelectElement, "kept");
      assert.equal(shared.querySelectorAll("li[data-shared]").length, 1, "the filter shows the required hand-over only");
      await setValue(shared.querySelector("select") as HTMLSelectElement, "link");
      await click(shared.querySelector("input[type=checkbox]"));
      await setValue([...host.querySelectorAll("input")].find(input => input.type !== "checkbox") as HTMLInputElement, "Video A · English");
      await click([...host.querySelectorAll("button")].find(button => button.textContent === "确认永久删除"));
      assert.equal(posts.length, 1);
      assert.deepEqual([posts[0].operation, posts[0].kind, posts[0].id, posts[0].unlinkShared], ["start", "language", "t-en", ["link:production_checkpoint_files:cpf-en-es"]]);
    } finally { await act(async () => { root.unmount(); }); host.remove(); }
  });
});
