import assert from "node:assert/strict";
import { test } from "node:test";
import { streamProjectFile } from "../db/backend";
import { env } from "../runtime/node-environment";
import { contractDatabase } from "./support/contract-database";

test("the current replacement editor can download task work and exact shared versions without an archive", async t => {
  const db = contractDatabase();
  t.mock.getter(env, "DB", () => db as unknown as typeof env.DB);
  t.mock.getter(env, "FILES", () => ({
    head: async () => ({ size: 1 }), signedRead: async (key: string) => "https://synthetic.invalid/" + key,
  }) as unknown as typeof env.FILES);
  const mode = process.env.FILE_TRANSFER_MODE;
  process.env.FILE_TRANSFER_MODE = "direct";
  t.after(() => { if (mode === undefined) delete process.env.FILE_TRANSFER_MODE; else process.env.FILE_TRANSFER_MODE = mode; db.sqlite.close(); });
  const editor = "next@example.test", previous = "former@example.test";
  for (const email of [editor, previous]) db.insert("accounts", { id: email, email, status: "active", access_group: "production" });
  db.insert("clients", { id: "client", status: "Active" });
  db.insert("projects", { id: "project", client_id: "client" });
  db.insert("deseret_project_links", { id: "project", deseret_project_id: "external" });
  for (const [id, assignee] of [["task", editor], ["sibling", previous]]) {
    db.insert("language_projects", { id, project_id: "project", editor_email: assignee, video_id: id });
    db.insert("aigc_folders", { id: "folder-"+id, language_project_id: id, project_id: "project", folder_code: "01", path_cache: "/01_客户资料" });
  }
  function file(id: string, task: string) {
    db.insert("aigc_files", { id, folder_id: "folder-"+task, language_project_id: task, current_version_id: id, status: "available" });
    db.insert("aigc_file_versions", { id, file_id: id, version_number: 1, original_name: id, created_by: "lead@example.test" });
    db.insert("project_files", { id, project_id: "project", language_project_id: task, directory: "01_客户资料", status: "available", object_key: id });
  }
  file("reference","task"); file("standard","sibling"); file("private","sibling");
  db.insert("material_standards", { id: "standard-row", project_id: "project", language_project_id: "sibling", scope_type: "project", is_current: 1, status: "current", logical_file_id: "standard", file_version_id: "standard" });
  const download = (id: string) => streamProjectFile(editor, id, true);
  await assert.rejects(download("reference"), /not available/i);
  db.insert("language_assignment_history", { id: "reassignment", language_project_id: "task", previous_editor_email: previous, new_editor_email: editor });
  for (const id of ["reference","standard"]) assert.equal((await download(id)).headers.get("location"), "https://synthetic.invalid/"+id);
  await assert.rejects(download("private"), /not available/i);
  db.insert("task_material_links", { id: "linked", language_project_id: "task", material_file_id: "private", material_version_id: "private" });
  assert.equal((await download("private")).headers.get("location"), "https://synthetic.invalid/private");
  db.sqlite.exec("DELETE FROM task_material_links");
  await assert.rejects(download("private"), /not available/i);
  db.insert("aigc_file_versions", { id: "standard-v2", file_id: "standard", version_number: 2 });
  db.insert("project_files", { id: "standard-v2", project_id: "project", language_project_id: "sibling", directory: "01_客户资料", status: "available" });
  await assert.rejects(download("standard-v2"), /not available/i);
  db.insert("handover_records", { id: "cancelled", language_project_id: "task", from_user_email: previous, to_user_email: editor, status: "cancelled" });
  await assert.rejects(download("reference"), /not available/i);
  db.sqlite.exec("DELETE FROM handover_records");
  db.sqlite.exec("UPDATE aigc_folders SET deleted_at='now' WHERE id='folder-task'");
  await assert.rejects(download("reference"), /not available/i);
  db.sqlite.exec("UPDATE aigc_folders SET deleted_at=NULL WHERE id='folder-task'");
  db.sqlite.exec("UPDATE material_standards SET is_current=0");
  await assert.rejects(download("standard"), /not available/i);
  db.sqlite.exec("UPDATE language_projects SET editor_email=NULL WHERE id='task'");
  await assert.rejects(download("reference"), /not available/i);
});
