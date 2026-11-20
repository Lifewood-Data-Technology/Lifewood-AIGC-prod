// Acceptance blocker: incoming Deseret material registration may reuse only a readable version already in the
// same task's 02_客户素材 folder. A same-name, same-SHA working draft in 03_项目制作 (not submitted for review)
// must not be reused, or an assigned QC reviewer could never open the material; it is registered in 02 instead.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeIntegrationFiles, reusableIncomingVersion } from "../db/deseret-native-files";
import { createHarness, OTHER_PROJECT, PROJECT, QC, type Harness } from "./support/deseret-harness";

const material = { name: "cover.png", size: 4096 };
const SHA = "c".repeat(64);
let h: Harness;
const copy = (id: string, taskId: string, directory: string, status = "available", projectId = PROJECT) =>
  h.addNative({ id, taskId, directory, status, name: material.name, mimeType: "image/png", size: material.size, sha256: SHA, projectId });
const reusable = async (taskId: string, projectId = PROJECT) => (await reusableIncomingVersion(h.db, projectId, taskId, material, SHA))?.id ?? null;

describe("Incoming material reuse is limited to the same task's 02_客户素材", () => {
  beforeEach(() => { h = createHarness(); });

  it("does not reuse a same-name, same-SHA unsubmitted draft in 03_项目制作", async () => {
    copy("draft-03", "task-1", "03_项目制作");
    assert.equal(await reusable("task-1"), null);
    // The draft is also not readable to the assigned reviewer, which is why it must not stand in for the material.
    assert.deepEqual(await nativeIntegrationFiles(h.context("quality", QC), ["draft-03"], { incomingMaterials: true }), []);
  });

  it("reuses a live copy in the task's own 02_客户素材, also when a 03 draft with the same content exists", async () => {
    copy("draft-03", "task-1", "03_项目制作");
    copy("client-02", "task-1", "02_客户素材");
    assert.equal(await reusable("task-1"), "client-02");
    assert.deepEqual((await nativeIntegrationFiles(h.context("quality", QC), ["client-02"], { incomingMaterials: true })).map(file => file.id), ["client-02"]);
  });

  it("does not reuse another task's 02 copy", async () => {
    copy("client-02-task-2", "task-2", "02_客户素材");
    assert.equal(await reusable("task-1"), null);
    assert.equal(await reusable("task-2"), "client-02-task-2");
  });

  it("does not reuse across projects, nor for a task outside the given project", async () => {
    copy("foreign-02", "task-x", "02_客户素材", "available", OTHER_PROJECT);
    assert.equal(await reusable("task-1"), null);
    assert.equal(await reusable("task-x"), null, "task-x belongs to another project");
    assert.equal(await reusable("task-x", OTHER_PROJECT), "foreign-02");
  });

  it("does not reuse a deleted copy or a copy whose 02 folder was deleted", async () => {
    copy("deleted-02", "task-1", "02_客户素材");
    h.db.sqlite.prepare("UPDATE project_files SET deleted_at='2026-11-20' WHERE id='deleted-02'").run();
    assert.equal(await reusable("task-1"), null);
    copy("live-02", "task-1", "02_客户素材");
    assert.equal(await reusable("task-1"), "live-02");
    h.db.sqlite.prepare("UPDATE aigc_folders SET deleted_at='2026-11-20' WHERE id='folder-task-1-02'").run();
    assert.equal(await reusable("task-1"), null);
  });

  it("does not reuse a copy moved out of 02, even though its logical file stays in the task", async () => {
    copy("moved", "task-1", "02_客户素材");
    h.db.sqlite.prepare("UPDATE project_files SET directory='03_项目制作' WHERE id='moved'").run();
    h.db.sqlite.prepare("UPDATE aigc_files SET folder_id='folder-task-1-03' WHERE id='logical-moved'").run();
    assert.equal(await reusable("task-1"), null);
  });

  it("requires the same name, checksum and size", async () => {
    copy("client-02", "task-1", "02_客户素材");
    assert.equal((await reusableIncomingVersion(h.db, PROJECT, "task-1", { ...material, name: "other.png" }, SHA)), null);
    assert.equal((await reusableIncomingVersion(h.db, PROJECT, "task-1", { ...material, size: 1 }, SHA)), null);
    assert.equal((await reusableIncomingVersion(h.db, PROJECT, "task-1", material, "d".repeat(64))), null);
  });
});
