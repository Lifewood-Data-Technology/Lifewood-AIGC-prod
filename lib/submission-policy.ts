import type { Database } from "../db/database";
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicError } from "./security-controls";

// These create actions need replay protection even when the response is lost.
export const protectedCreates = new Set(["client.create", "client.import", "sales.project_request.create", "project.request.accept", "project.create", "project.video.add", "project.language.add", "project.schedule", "asset.collection.create"]);
export function canonicalSubmission(action: string, payload: Record<string, string>) {
  return JSON.stringify([action, Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))]);
}
export async function submissionDigest(value: string) {
  const input = new TextEncoder().encode(value);
  const bytes = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input))
    : sha256(input);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A claimed request is never automatically replayed after a server-side failure. */
export async function executeSubmission(db: Database, actor: string, id: string, hash: string, action: () => Promise<unknown>) {
  if (!/^[a-f0-9-]{36,64}$/.test(id)) return { status: 400, body: { error: "请刷新页面后提交，缺少安全提交编号。 / Refresh before submitting.", code: "SUBMISSION_ID_REQUIRED" } };
  const claimed = await db.prepare("INSERT OR IGNORE INTO workflow_submissions (id, account_email, payload_hash, state, response_json, created_at) VALUES (?, ?, ?, 'pending', '', ?)").bind(id, actor, hash, new Date().toISOString()).run();
  if (Number(claimed.meta.changes) !== 1) {
    const previous = await db.prepare("SELECT account_email, payload_hash, state, response_json FROM workflow_submissions WHERE id = ?").bind(id).first<{ account_email: string; payload_hash: string; state: string; response_json: string }>();
    if (!previous || previous.account_email !== actor || previous.payload_hash !== hash) return { status: 409, body: { error: "提交编号不匹配，请核对后重新填写。 / Submission identity mismatch.", code: "SUBMISSION_MISMATCH" } };
    if (previous.state === "done") return { status: 200, body: JSON.parse(previous.response_json) };
    return { status: 409, body: { error: "之前这次提交尚未确认，请先刷新列表核对，不要重复新建。若一直未完成，请让管理员核查提交编号：" + id, code: "SUBMISSION_UNCONFIRMED" } };
  }
  try {
    const result = await action();
    await db.prepare("UPDATE workflow_submissions SET state = 'done', response_json = ? WHERE id = ? AND account_email = ? AND state = 'pending'").bind(JSON.stringify(result), id, actor).run();
    return { status: 200, body: result };
  } catch (error) {
    // PublicError is either validation or a transaction guard failure. No
    // business write has committed, so remove the pending claim and let the
    // user correct/refresh and safely retry with the same submission id.
    if (error instanceof PublicError) {
      await db
        .prepare(
          "DELETE FROM workflow_submissions WHERE id = ? AND account_email = ? AND state = 'pending'",
        )
        .bind(id, actor)
        .run();
      return {
        status: error.status,
        body: { error: error.message, code: error.code },
      };
    }
    // A business action may have committed before a downstream write failed.
    // Retain the claim, even across a worker restart. Do not guess it rolled back.
    const message = error instanceof Error ? error.message : "Action failed";
    return { status: 400, body: { error: /D1_|SQLITE_|database|SQL|constraint/i.test(message) ? "提交未确认，请先核对列表；原草稿已保留。" : message, code: "SUBMISSION_UNCONFIRMED", submissionId: id } };
  }
}
