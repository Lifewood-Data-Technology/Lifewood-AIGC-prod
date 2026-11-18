import type { Database } from "./database";
import { PublicError } from "../lib/security-controls";

type Reference = { version_number: number | null; kind: string; number: number | null };
const labels: Record<string, (number: number | null) => string> = {
  quality: number => number ? `QC round ${number}` : "a QC round",
  quality_report: number => number ? `the QC round ${number} report` : "a QC report",
  final: () => "a final submission",
  final_material: () => "a final submission's materials",
  report: number => number ? `daily report v${number}` : "a daily report",
  delivery: () => "a delivery",
  share: () => "a share link",
  standard: () => "a material standard",
};
type Target = { logicalFileId?: string; versionId?: string };
// A logical-file delete removes every version; a single-version delete removes only that version.
const versionSet = (target: Target) => target.versionId ? { sql: "v.id=?", value: target.versionId } : { sql: "v.file_id=?", value: target.logicalFileId ?? "" };

/** The exact versions bound to formal records stay; the first one found is named in a readable reason. */
export async function fileVersionReferences(db: Database, target: Target) {
  const versions = versionSet(target);
  return (await db.prepare(`SELECT v.version_number, r.kind, r.number FROM aigc_file_versions v JOIN (
      SELECT m.file_version_id AS version_id, 'report' AS kind, cp.version_number AS number FROM production_checkpoint_files m JOIN production_checkpoints cp ON cp.id=m.checkpoint_id
      UNION ALL SELECT m.file_version_id, 'final_material', NULL FROM production_final_submission_files m
      UNION ALL SELECT s.final_version_id, 'final', NULL FROM production_final_submissions s
      UNION ALL SELECT q.file_id, 'quality', q.round_number FROM quality_rounds q
      UNION ALL SELECT q.report_file_id, 'quality_report', q.round_number FROM quality_rounds q WHERE q.report_file_id IS NOT NULL
      UNION ALL SELECT d.file_id, 'delivery', NULL FROM deliveries d
      UNION ALL SELECT s.file_id, 'share', NULL FROM share_links s
      UNION ALL SELECT m.file_version_id, 'standard', NULL FROM material_standards m
    ) r ON r.version_id=v.id WHERE ${versions.sql}
    UNION ALL SELECT NULL, 'standard', NULL FROM material_standards WHERE ?<>'' AND logical_file_id=?
    ORDER BY 1, 2`).bind(versions.value, target.logicalFileId ?? "", target.logicalFileId ?? "").all<Reference>()).results;
}

export function referenceReason(reference: Reference) {
  const target = (labels[reference.kind] ?? (() => "a formal record"))(reference.number);
  return `${reference.version_number ? `Version ${reference.version_number}` : "This file"} is referenced by ${target}. Versions bound to formal records cannot be deleted.`;
}

/** Recheck for the delete transaction, scoped exactly to what the delete removes: one old version, or
 * (for a logical-file delete) every version plus standards bound to the logical file. */
export function versionsUnreferenced(target: { versionId: string } | { logicalFileId: string }) {
  const versions = "versionId" in target ? "?" : "SELECT id FROM aigc_file_versions WHERE file_id=?";
  const value = "versionId" in target ? target.versionId : target.logicalFileId;
  const checks = [
    `NOT EXISTS(SELECT 1 FROM quality_rounds q WHERE q.file_id IN (${versions}) OR q.report_file_id IN (${versions}))`,
    `NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.file_id IN (${versions}))`,
    `NOT EXISTS(SELECT 1 FROM share_links s WHERE s.file_id IN (${versions}))`,
    `NOT EXISTS(SELECT 1 FROM production_checkpoint_files m WHERE m.file_version_id IN (${versions}))`,
    `NOT EXISTS(SELECT 1 FROM production_final_submission_files m WHERE m.file_version_id IN (${versions}))`,
    `NOT EXISTS(SELECT 1 FROM production_final_submissions s WHERE s.final_version_id IN (${versions}))`,
    `NOT EXISTS(SELECT 1 FROM material_standards m WHERE m.file_version_id IN (${versions}))`,
    ...("logicalFileId" in target ? ["NOT EXISTS(SELECT 1 FROM material_standards m WHERE m.logical_file_id=?)"] : []),
  ];
  const sql = checks.join(" AND ");
  return { sql, values: Array<string>((sql.match(/\?/g) ?? []).length).fill(value) };
}

/** Called before a file or version is moved to the recycle bin; the delete transaction rechecks. */
export async function assertFileDeletable(db: Database, target: Target) {
  if (!target.logicalFileId && !target.versionId) return;
  const [reference] = await fileVersionReferences(db, target);
  if (reference) throw new PublicError(referenceReason(reference), 400, "FILE_VERSION_REFERENCED");
}
