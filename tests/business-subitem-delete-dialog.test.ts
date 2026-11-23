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

it("shows the storage blocker before the file list and prevents confirmation", async () => {
  const host = window.document.createElement("div");
  const root = ReactDOM.createRoot(host);
  const methods: string[] = [];
  window.document.body.append(host);
  try {
    for (const [reason, locale, expected] of [
      ["PERMANENT_DELETION_DISABLED", "zh", "管理员尚未启用永久删除。"],
      ["PERMANENT_DELETION_RESOURCE_MISMATCH", "en", "Ask an administrator to check the storage configuration"],
      ["PERMANENT_DELETION_LOCATION_MISMATCH", "zh", "所选文件位于允许清理的存储范围之外"],
      ["UNRECOGNIZED", "en", "Storage could not be verified"],
    ] as const) {
      globalThis.fetch = (async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({ ...preview, availability: { enabled: false, reason } });
      }) as typeof fetch;
      await act(async () => { root.render(React.createElement(Dialog, { key: reason, targets: [target], locale, close() {}, onDeleted() {} })); });
      await settle();
      const notice = host.querySelector('[role="status"]')!;
      assert.ok(notice.textContent?.includes(expected));
      const fileList = host.querySelector(".delete-disclosure")!;
      assert.ok(notice.compareDocumentPosition(fileList) & window.Node.DOCUMENT_POSITION_FOLLOWING);
      assert.equal(host.querySelector("input[autocomplete=off]"), null);
      const confirm = host.querySelector<HTMLButtonElement>("footer button.danger")!;
      assert.equal(confirm.disabled, true);
      await click(confirm);
    }
    assert.ok(methods.length >= 4 && methods.every(method => method === "GET"));
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("shows a subitem recovery action only for this account's saved receipt, and keeps an open review visible", async () => {
  const { default: PendingButton } = await import("../app/PendingBusinessDeletionButton.tsx");
  const { DraftOwner } = await import("../app/useLocalDraft.tsx");
  const { deletionReceiptKey, notifyBusinessDeletionReceiptsChanged } = await import("../lib/business-deletion-receipt");
  const owner = "current-owner", item = { kind: "language", id: "recovery-test" } as const;
  const receipt = JSON.stringify({ ...item, submissionId: "recovery-test-0001", revision: 1, previewHash: "a".repeat(64), confirmationName: "Video A · English" });
  const host = window.document.createElement("div"), root = ReactDOM.createRoot(host);
  window.document.body.append(host);
  window.localStorage.setItem(deletionReceiptKey("other-owner", item), receipt);
  globalThis.fetch = (async (_input, init) => {
    assert.notEqual(init?.method, "POST");
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
  try {
    await act(async () => {
      root.render(React.createElement(DraftOwner.Provider, { value: owner },
        ...(["video", "language"] as const).map(kind => React.createElement(PendingButton, { key: kind, kind, label: kind, locale: "en", onDeleted() {} }))));
    });
    await settle();
    assert.equal(host.querySelector("button"), null);
    await act(async () => { window.localStorage.setItem(deletionReceiptKey(owner, item), receipt); notifyBusinessDeletionReceiptsChanged(); });
    assert.deepEqual([...host.querySelectorAll("button")].map(button => button.textContent), ["language"]);
    await click(host.querySelector("button"));
    await act(async () => { window.localStorage.removeItem(deletionReceiptKey(owner, item)); notifyBusinessDeletionReceiptsChanged(); });
    assert.ok(host.querySelector("dialog[open]"));
    assert.equal(host.querySelector(":scope > button"), null);
  } finally { await act(async () => root.unmount()); host.remove(); window.localStorage.clear(); }
});
