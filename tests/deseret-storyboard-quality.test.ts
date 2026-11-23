import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { qualityReviewTransition } from "../db/deseret-quality-review";
import { guardedMutation } from "../db/mutation-guard";
import { createHarness, finalReviewState, PROJECT } from "./support/deseret-harness";

function reviewFixture(count: number) {
  const state = finalReviewState();
  state.stage = "production";
  state.scenes = Array.from({ length: count }, (_, i) => ({ ...state.scenes[0], id: `scene-${i}`, order: i+1, fileVersionId: `cut-${i}` }));
  const h = createHarness(state);
  for (const scene of state.scenes) {
    h.addNative({ id: scene.fileVersionId, taskId: scene.languageTaskId, directory: "03_项目制作", status: "pending_qc",
      name: "scene.mp4", mimeType: "video/mp4", size: 555, sha256: "a".repeat(64) });
  }
  const task = "task-1";
  h.db.sqlite.prepare("UPDATE language_projects SET status='待质检' WHERE id=?").run(task);
  const prepare = async (id: string, approved: boolean) => {
    const revision = Number(h.db.sqlite.prepare("SELECT revision FROM language_projects WHERE id=?").get(task)?.revision);
    const decision = await qualityReviewTransition(h.db, PROJECT, task, id, approved);
    return async () => {
      await guardedMutation(h.db, `${decision.guard.sql} AND EXISTS(SELECT 1 FROM language_projects WHERE id=? AND status='待质检' AND revision=?)`,
        [...decision.guard.values, task, revision], [
          h.db.prepare("UPDATE project_files SET status=? WHERE id=?").bind(approved ? "qc_approved" : "rejected", id),
          h.db.prepare("UPDATE language_projects SET status=?,revision=revision+1 WHERE id=?").bind(decision.nextStatus, task),
        ]);
      return decision.nextStatus;
    };
  };
  return { ...h, prepare, task };
}

describe("Deseret storyboard QC", () => {
  it("keeps the queue open until every submitted scene has an outcome and retains individual approvals", async () => {
    const h = reviewFixture(6);
    const decide = async (index: number, approved: boolean) => (await h.prepare(`cut-${index}`, approved))();
    const stale = await h.prepare("cut-5", true);
    assert.equal(await decide(2, false), "待质检");
    await assert.rejects(stale, /changed/i);
    for (const i of [0,1,3,5]) assert.equal(await decide(i, true), "待质检");
    assert.equal(await decide(4, true), "质检驳回");
    const approved = h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM project_files WHERE status='qc_approved'").get()?.n;
    assert.equal(approved, 5);
    const link = h.db.sqlite.prepare("SELECT state_json FROM deseret_project_links WHERE id=?").get(PROJECT);
    const state = JSON.parse(String(link?.state_json));
    state.scenes[2].fileVersionId = "new-cut";
    h.db.sqlite.prepare("UPDATE deseret_project_links SET state_json=?,revision=revision+1 WHERE id=?").run(JSON.stringify(state), PROJECT);
    h.db.sqlite.prepare("UPDATE language_projects SET status='待质检',revision=revision+1 WHERE id=?").run(h.task);
    h.addNative({id:"new-cut",taskId:h.task,directory:"03_项目制作",status:"pending_qc",name:"replace.mp4",mimeType:"video/mp4",size:556,sha256:"b".repeat(64)});
    assert.equal(await (await h.prepare("new-cut", true))(), "制作中");
    assert.equal(h.db.sqlite.prepare("SELECT status FROM project_files WHERE id='cut-2'").get()?.status, "rejected");
    await assert.rejects(h.prepare("cut-2", true), /no longer awaiting/);
  });

  it("handles a single scene, changed project state and native finals", async () => {
    const h = reviewFixture(1);
    const single = await h.prepare("cut-0", true);
    h.db.sqlite.prepare("UPDATE deseret_project_links SET revision=revision+1 WHERE id=?").run(PROJECT);
    await assert.rejects(single, /changed/i);
    assert.equal(await (await h.prepare("cut-0",true))(), "制作中");
    const native = await qualityReviewTransition(h.db, "ordinary", h.task, "native-cut", true);
    assert.equal(native.nextStatus, "待客户预览");
  });

  it("keeps a pending final reviewable when the lead publishes or withdraws an older cut, including legacy submissions", async () => {
    const h = reviewFixture(1);
    for (const id of ["final-v2", "legacy-final", "unsubmitted"]) h.addNative({
      id, taskId:h.task, directory:"03_项目制作", status:"pending_qc", name:"cut.mp4", mimeType:"video/mp4", size:555, sha256:"b".repeat(64),
    });
    h.db.sqlite.prepare("INSERT INTO production_final_submissions VALUES ('receipt-2','final-v2',?,'editor')").run(h.task);
    h.db.sqlite.prepare("INSERT INTO production_submission_receipts VALUES ('receipt-2','editor',?)").run(JSON.stringify({ deseretPhase:"final",finalVersionId:"final-v2" }));
    h.db.sqlite.prepare("INSERT INTO aigc_file_operations(file_id,operation,details) VALUES ('logical-legacy-final','production.deseret_final_submitted','legacy-final')").run();
    for (const stage of ["final_production", "final_review", "revision", "production"]) {
      h.db.sqlite.prepare("UPDATE deseret_project_links SET state_json=json_set(state_json,'$.stage',?),revision=revision+1 WHERE id=?").run(stage,PROJECT);
      for (const id of ["final-v2","legacy-final"]) {
        const decision = await qualityReviewTransition(h.db,PROJECT,h.task,id,false);
        assert.equal(decision.nextStatus,"质检驳回");
        assert.equal(decision.sceneOrder,null);
        assert.equal(h.db.sqlite.prepare(`SELECT ${decision.guard.sql} AS ok`).get(...decision.guard.values)?.ok,1);
      }
      await assert.rejects(h.prepare("unsubmitted", true), /no longer awaiting/);
      if (stage !== "production") await assert.rejects(h.prepare("cut-0",true), /no longer awaiting/);
    }
  });
});
