// Renders the real production panel in jsdom with workspaces projected by the real integration service, so the
// labels are checked after the existing per-account filtering. Final QA return issues must name the Deseret role
// that raised them (Marketing, Creative, Publisher QA); ordinary publisher feedback and author feedback keep
// their original labels.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import type { ComponentType } from "react";
import { concludedEnvelope, createHarness, finalReviewState, LEAD, MAKER, OTHER_QC, PROJECT, type Harness, type Row } from "./support/deseret-harness";

register("./support/tsx-load.mjs", import.meta.url);
// jsdom ships without type declarations; this is the only part of its API the test uses.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis };
};
const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://aigc.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : (window as unknown as Row)[key] });
(globalThis as Row).IS_REACT_ACT_ENVIRONMENT = true;

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

const issue = (id: string, role: string, sceneId: string, body: string): Row => ({ id, role, actorId: `${role}-reviewer`, sceneId, sceneVersion: 1, body, frames: [] });
let h: Harness;
beforeEach(async () => {
  const initial = finalReviewState();
  // Records that existed before the return: an ordinary publisher comment and an author comment.
  initial.feedback.push({ id: "fb-ordinary", type: "review.feedback", packageId: "pkg-final-1", sceneId: "final-task-1", body: "Ordinary publisher comment", actorId: "mkt-3", createdAt: "2026-11-19T08:00:00.000Z" });
  initial.authorFeedback.push({ id: "fb-author", type: "author.feedback", packageId: "pkg-final-1", body: "Author comment", actorId: "author-1", createdAt: "2026-11-19T09:00:00.000Z" });
  h = createHarness(initial);
  const [envelope, raw] = concludedEnvelope({ actorId: "qa-reviewer-7", body: "Fix the listed issues.", sceneId: "final-task-1", issues: [
    issue("iss-qa", "publisher_qa", "final-task-1", "QA: title is cut off"),
    issue("iss-marketing", "marketing", "final-task-1", "Marketing: logo too small"),
    issue("iss-creative", "creative", "final-task-1", "Creative: colour grade too dark"),
    issue("iss-task-2", "creative", "final-task-2", "Creative: second cut ends early"),
  ] });
  assert.deepEqual(await h.service.receive(envelope, raw), { accepted: true, eventId: "evt-final-revision" });
});

/** Mounts the panel for one account and returns each feedback card as [label, source role attribute, body]. */
async function cards(email: string, locale: "en" | "zh") {
  const workspace = JSON.parse(JSON.stringify(await h.service.workspace(email, PROJECT)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    return url.pathname === "/api/deseret-book" && url.searchParams.get("project") === PROJECT
      ? Response.json(workspace) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = ReactDOM.createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Panel, { projectId: PROJECT, locale })));
    for (let attempt = 0; attempt < 50 && !host.querySelector("blockquote"); attempt++)
      await React.act(() => new Promise(resolve => setTimeout(resolve, 10)));
    return [...host.querySelectorAll("blockquote")].map(card => {
      const label = card.querySelector(":scope > strong")!;
      // The first paragraph is the package/scene location; the second is the record body.
      return [label.textContent, label.getAttribute("data-source-role"), card.querySelectorAll(":scope > p")[1]?.textContent];
    });
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
  }
}

describe("Final QA return issues show their Deseret source role in the production panel", () => {
  it("shows the lead every issue with its source, in English", async () => {
    assert.deepEqual(await cards(LEAD, "en"), [
      ["Publisher feedback", null, "Ordinary publisher comment"],
      ["Publisher feedback", null, "Fix the listed issues."],
      ["Publisher QA issue", "publisher_qa", "QA: title is cut off"],
      ["Marketing issue", "marketing", "Marketing: logo too small"],
      ["Creative issue", "creative", "Creative: colour grade too dark"],
      ["Creative issue", "creative", "Creative: second cut ends early"],
      ["Author feedback", null, "Author comment"],
    ]);
  });

  it("shows the task-1 maker only their filtered issues with Chinese source labels", async () => {
    assert.deepEqual(await cards(MAKER, "zh"), [
      ["出版社意见", null, "Ordinary publisher comment"],
      ["出版社意见", null, "Fix the listed issues."],
      ["出版社 QA 意见", "publisher_qa", "QA: title is cut off"],
      ["营销意见", "marketing", "Marketing: logo too small"],
      ["创意意见", "creative", "Creative: colour grade too dark"],
      ["作者意见", null, "Author comment"],
    ]);
  });

  it("shows the other task's QC only the issue of their scene, with its source", async () => {
    assert.deepEqual(await cards(OTHER_QC, "zh"), [
      ["创意意见", "creative", "Creative: second cut ends early"],
      ["作者意见", null, "Author comment"],
    ]);
  });
});
