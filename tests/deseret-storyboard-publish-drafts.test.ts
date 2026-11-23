import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, finalReviewState, LEAD, MAKER, QC, PROJECT } from "./support/deseret-harness";
import type { DeseretIntegrationState } from "../lib/deseret-workspace";

function productionWithDraft() {
  const state: DeseretIntegrationState = {
    ...finalReviewState(), stage: "production", packages: [], scenes: [], revisionSceneIds: [],
    storyboardDrafts: [{ languageTaskId: "task-1", sceneId: "scene-7", sceneVersion: 0, duration: 7, fileVersionId: "private-draft" }],
  };
  return createHarness(state);
}

describe("drafts and publisher review", () => {
  it("keeps draft version IDs inside the editor's production workspace", async () => {
    const h = productionWithDraft();
    for (const actor of [QC, LEAD, MAKER]) {
      const workspace = await h.service.workspace(actor, PROJECT);
      assert.ok(!JSON.stringify(workspace).includes("private-draft"));
      assert.equal(workspace.storyboardDraftCount, actor === LEAD ? 1 : undefined);
    }
  });
  it("cannot publish a partial package while an editor has an outstanding draft", async () => {
    const h = productionWithDraft();
    await h.rejectsUnchanged(() => h.service.command(LEAD, PROJECT, {
      action: "package.publish", requestId: "publish-drafts", expectedRevision: h.state().revision, payload: { phase: "storyboard" },
    }), "DESERET_STORYBOARD_DRAFTS_PENDING");
  });
});

it("publishes all seven approved versions even when a terminated task retains a draft", async () => {
  const scenes = Array.from({ length: 7 }, (_, index) => ({
    id: `scene-${index + 1}`, order: index + 1, version: index === 3 ? 2 : 1, duration: 4,
    fileVersionId: `cut-${index}-${index === 3 ? "revised" : "original"}`, languageTaskId: "task-1", characterIds: [], voiceId: "",
  }));
  const h = createHarness({ ...finalReviewState(), stage: "production", scenes, packages: [], revisionSceneIds: [],
    storyboardDrafts: [{languageTaskId:"task-2", sceneId:"shelved", fileVersionId:"unused", sceneVersion:0, duration:1}] });
  h.db.sqlite.prepare("UPDATE language_projects SET status='已终止' WHERE id='task-2'").run();
  assert.equal((await h.service.workspace(LEAD,PROJECT)).storyboardDraftCount, 0);
  for (const scene of scenes) h.addNative({ id: scene.fileVersionId, taskId: "task-1", directory: "03_项目制作",
    name: `${scene.id}.mp4`, mimeType: "video/mp4", size: 1024, status: "qc_approved", sha256: "a".repeat(64), qualityApproved: true });
  const result = await h.service.command(LEAD, PROJECT, {
    action: "package.publish", requestId: "send-reviewed-scenes", expectedRevision: h.state().revision, payload: { phase: "storyboard" },
  });
  assert.equal(result.stage, "storyboard_review");
  assert.deepEqual(result.packages.at(-1)?.files.map(file => file.fileVersionId), scenes.map(scene => scene.fileVersionId));
});
