// Recovering Deseret internal archive uploads while a task is under internal QC or publisher review: the unfinished
// list accepts the archive purpose and authorises by that purpose (and only lists that purpose), and the global
// "return to original form" reopens the archive form, not an unknown mode. Other purposes are unchanged.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDirectUploadService } from "../db/direct-upload-service";
import { productionRecoveryTarget } from "../lib/direct-upload-contract";
import { sqliteDatabase } from "./support/sqlite-database";

const MAKER = "maker@example.test";
function service() {
  const db = sqliteDatabase();
  db.sqlite.exec(`CREATE TABLE direct_upload_sessions (id TEXT PRIMARY KEY, registration_id TEXT, actor_email TEXT, request_hash TEXT, payload_json TEXT, assets_json TEXT,
    authority_json TEXT, state TEXT, result_json TEXT, claim_id TEXT, lease_expires_at TEXT, expires_at TEXT, scopes_json TEXT, updated_at TEXT, created_at TEXT, cleaned_at TEXT)`);
  const add = (id: string, purpose: string) => db.sqlite.prepare("INSERT INTO direct_upload_sessions (id,actor_email,payload_json,assets_json,state,expires_at,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, MAKER, JSON.stringify({ id, endpoint: "/api/production-workspace", fields: { task: "task-1", purpose, category: "project", id }, file: { name: `${purpose}.prproj`, type: "application/octet-stream", size: 10, sha256: "a".repeat(64) } }),
      "[]", "cancelled", "2099-01-01T00:00:00.000Z", "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
  add("00000000-0000-4000-8000-00000000000a", "archive");
  add("00000000-0000-4000-8000-00000000000b", "materials");
  const calls: string[][] = [];
  const uploads = createDirectUploadService({ db, bucket: {} as never, dispatch: async () => { throw new Error("not used"); }, scopes: async () => [],
    authorizeList: async (actor: string, taskId: string, purpose?: string) => { calls.push([actor, taskId, String(purpose)]); } } as Parameters<typeof createDirectUploadService>[0]);
  return { uploads, calls };
}

describe("unfinished archive uploads", () => {
  it("lists archive uploads under the archive purpose only, authorised for that purpose", async () => {
    const { uploads, calls } = service();
    const archive = await uploads.list(MAKER, "task-1", "archive", "");
    assert.deepEqual(archive.uploads.map(item => item.input.fields.purpose), ["archive"]);
    assert.deepEqual(calls, [[MAKER, "task-1", "archive"]]);
    const materials = await uploads.list(MAKER, "task-1", "materials", "");
    assert.deepEqual(materials.uploads.map(item => item.input.fields.purpose), ["materials"]);
    assert.deepEqual(calls.at(-1), [MAKER, "task-1", "materials"]);
    await assert.rejects(() => uploads.list(MAKER, "task-1", "anything-else", ""), /Invalid upload selection/);
  });

  it("returns an archive upload to the archive form; other purposes to their own form", () => {
    assert.deepEqual(productionRecoveryTarget({ task: "task-1", purpose: "archive", id: "u1" }), { taskId: "task-1", mode: "materials", archive: true, recoveredFileId: "u1" });
    assert.deepEqual(productionRecoveryTarget({ task: "task-1", purpose: "final", id: "u2" }), { taskId: "task-1", mode: "final", recoveredFileId: "u2" });
    assert.deepEqual(productionRecoveryTarget({ task: "task-1", purpose: "materials", id: "u3" }), { taskId: "task-1", mode: "materials", recoveredFileId: "u3" });
  });
});
