// Internal Deseret production continuity: per-task archives, the archive pinned to each published scene, and the
// incoming editor's verification after a handover. Everything here is AIGC-internal. None of it is ever written to
// integration state, publisher events, material transfer tasks or resends; callers keep it in these tables only.
import { randomUUID } from "node:crypto";
import type { Database, DatabaseStatement } from "./database";
import { liveLogicalFileSql } from "./file-integrity";
import { PublicError } from "../lib/security-controls";
import { publishableArchive } from "../lib/deseret-workspace";
import type { DeseretArchive, DeseretArchiveCandidate, DeseretArchiveFile, DeseretPackageSource, DeseretScene, DeseretTaskHandover } from "../lib/deseret-workspace";

type Row = Record<string, unknown>;
/**
 * A version-id subquery limiting what an editor may archive: `productionReadableVersionQuery(email)`. Absent for the
 * lead, who keeps project access. Registering never grants access the editor did not already have.
 */
export type ReadableVersions = { sql: string; values: (string | number | null)[] };
export const ENGINEERING_FOLDER = "03.project";
const MAX_MATERIALS = 50, MAX_NEXT_STEPS = 4000;
const identity = /^[A-Za-z0-9_.:-]{1,255}$/;

/**
 * Live formal versions of one task in one project. `taskExpression` and `projectExpression` each appear twice; a
 * "?" there needs its value bound twice. The three arguments are SQL expressions, so the same rule is
 * used for registration, the write-transaction guard and read-time validity. Staged uploads have no version row;
 * library files have no task; deleted or recycled files fail `liveLogicalFileSql`.
 */
function liveVersionSql(versionCondition: string, taskExpression: string, projectExpression: string) {
  return `SELECT v.id, v.original_name AS name, v.version_number AS version, pf.mime_type, folder.folder_code
    FROM aigc_file_versions v JOIN aigc_files f ON f.id=v.file_id JOIN aigc_folders folder ON folder.id=f.folder_id
    JOIN project_files pf ON pf.id=v.id JOIN language_projects lp ON lp.id=f.language_project_id
    WHERE ${versionCondition} AND f.language_project_id=${taskExpression} AND pf.language_project_id=${taskExpression}
      AND lp.project_id=${projectExpression} AND pf.project_id=${projectExpression}
      AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")}`;
}
const invalid = (message: string): never => { throw new PublicError(message, 422, "DESERET_ARCHIVE_INVALID"); };

/** Write-transaction guard: this exact version is still filed under Project files (03.project) of the task. */
export function engineeringFolderGuard(versionId: string, taskId: string) {
  return { sql: `EXISTS(SELECT 1 FROM aigc_file_versions v JOIN aigc_files f ON f.id=v.file_id JOIN aigc_folders folder ON folder.id=f.folder_id
    WHERE v.id=? AND f.language_project_id=? AND folder.folder_code='${ENGINEERING_FOLDER}' AND folder.deleted_at IS NULL)`, values: [versionId, taskId] as (string | number | null)[] };
}

/** Saved versions must remain live in both the selected language task and its project at commit. */
export function savedArchiveVersionsGuard(ids: string[], taskId: string, projectId: string) {
  return { sql: `NOT EXISTS(SELECT 1 FROM json_each(?) chosen WHERE NOT EXISTS(${liveVersionSql("v.id=chosen.value", "?", "?")}))`,
    values: [JSON.stringify(ids), taskId, taskId, projectId, projectId] };
}

export type ArchiveInput = { projectVersionId: string; previewVersionId?: string; materialVersionIds?: string[]; nextSteps?: string };

/**
 * Validates one archive of `taskId` and returns its statements plus a guard that re-checks every referenced
 * version in the write transaction. The archive number is assigned inside the INSERT; the unique (task, number)
 * index rejects a concurrent duplicate.
 */
export async function archiveSelection(db: Database, projectId: string, taskId: string, input: ArchiveInput, email: string, now = new Date().toISOString(), readable?: ReadableVersions) {
  const materials = input.materialVersionIds ?? [];
  if (typeof input.projectVersionId !== "string" || !identity.test(input.projectVersionId)) invalid("Choose the engineering file version.");
  if (input.previewVersionId !== undefined && (typeof input.previewVersionId !== "string" || !identity.test(input.previewVersionId))) invalid("Choose a valid preview version.");
  if (!Array.isArray(materials) || materials.length > MAX_MATERIALS || materials.some(id => typeof id !== "string" || !identity.test(id))) invalid(`Choose up to ${MAX_MATERIALS} material versions.`);
  if (input.nextSteps !== undefined && (typeof input.nextSteps !== "string" || input.nextSteps.length > MAX_NEXT_STEPS)) invalid(`Next steps are limited to ${MAX_NEXT_STEPS} characters.`);
  const roles = new Map<string, "project" | "preview" | "material">([[input.projectVersionId, "project"]]);
  if (input.previewVersionId && !roles.has(input.previewVersionId)) roles.set(input.previewVersionId, "preview");
  for (const id of materials) if (!roles.has(id)) roles.set(id, "material");
  const ids = [...roles.keys()];
  const rows = (await db.prepare(liveVersionSql(`v.id IN (SELECT value FROM json_each(?))${readable ? ` AND v.id IN (${readable.sql})` : ""}`, "?", "?"))
    .bind(JSON.stringify(ids), ...(readable?.values ?? []), taskId, taskId, projectId, projectId).all<Row>()).results;
  const found = new Map(rows.map(row => [String(row.id), row]));
  if (found.get(input.projectVersionId)?.folder_code !== ENGINEERING_FOLDER) invalid("The engineering file must be a current-task file in Project files.");
  if (input.previewVersionId && !String(found.get(input.previewVersionId)?.mime_type ?? "").startsWith("video/")) invalid("The preview must be a video of this task.");
  if (ids.some(id => !found.has(id))) invalid("Every archived file must be a registered file of this task.");
  const { id, statements } = archiveStatements(db, { projectId, taskId, email, now, nextSteps: input.nextSteps, files: ids.map(fileId => ({ id: fileId, role: roles.get(fileId)! })) });
  const readableGuard = readable ? ` AND NOT EXISTS(SELECT 1 FROM json_each(?) chosen WHERE chosen.value NOT IN (${readable.sql}))` : "";
  const folder = engineeringFolderGuard(input.projectVersionId, taskId);
  const saved = savedArchiveVersionsGuard(ids, taskId, projectId);
  return { id, statements, guard: { sql: `${saved.sql}${readableGuard} AND ${folder.sql}`,
    values: [...saved.values, ...(readable ? [JSON.stringify(ids), ...readable.values] : []), ...folder.values] } };
}

export type NativeArchiveInput = {
  ids: string[];
  /** New uploads committed in this transaction, with the category they are filed under (`project` = 03.project). */
  staged: { id: string; category: string; kind: string }[];
  /** Saved versions with their real folder from the database; the form cannot reclassify them. */
  existing: { id: string; folderCode: string; kind: string }[];
  projectVersionId: string; previewVersionId?: string;
};
/** The archive files of a native upload: the engineering file must really be filed under Project files. */
export function nativeArchiveFiles(input: NativeArchiveInput): { id: string; role: "project" | "preview" | "material" }[] {
  const staged = new Map(input.staged.map(file => [file.id, file])), existing = new Map(input.existing.map(file => [file.id, file]));
  const project = input.projectVersionId, preview = input.previewVersionId || "";
  const engineering = (id: string) => staged.has(id) ? staged.get(id)!.category === "project" : existing.get(id)?.folderCode === ENGINEERING_FOLDER;
  if (input.ids.some(id => !staged.has(id) && !existing.has(id))) invalid("Every archived file must be a file of this task.");
  if (!input.ids.includes(project) || !engineering(project)) invalid("Choose this task's engineering file (Project files) to archive.");
  if (preview && (!input.ids.includes(preview) || preview === project || (staged.get(preview)?.kind ?? existing.get(preview)?.kind) !== "video")) invalid("The preview must be a selected video.");
  return input.ids.map(id => ({ id, role: id === project ? "project" : id === preview ? "preview" : "material" }));
}

/**
 * The INSERTs of one archive. Callers validate the files first: `archiveSelection` for registered versions, the
 * native archive upload for versions committed in the same transaction.
 */
export function archiveStatements(db: Database, input: { projectId: string; taskId: string; email: string; now: string; nextSteps?: string; files: { id: string; role: "project" | "preview" | "material" }[] }) {
  const id = randomUUID();
  const statements: DatabaseStatement[] = [
    db.prepare("INSERT INTO deseret_production_archives(id,project_id,language_project_id,archive_number,created_by_email,next_steps,created_at) SELECT ?,?,?,COALESCE(MAX(archive_number),0)+1,?,?,? FROM deseret_production_archives WHERE language_project_id=?")
      .bind(id, input.projectId, input.taskId, input.email, input.nextSteps?.trim() ?? "", input.now, input.taskId),
    ...input.files.map(file => db.prepare("INSERT INTO deseret_archive_files(id,archive_id,language_project_id,file_version_id,role,created_at) VALUES(?,?,?,?,?,?)")
      .bind(randomUUID(), id, input.taskId, file.id, file.role, input.now)),
  ];
  return { id, statements };
}

/** Archives of the given tasks, newest first per task, with validity recomputed from the referenced versions. */
export async function taskArchives(db: Database, projectId: string, taskIds: string[]): Promise<DeseretArchive[]> {
  if (!taskIds.length) return [];
  const archives = (await db.prepare("SELECT * FROM deseret_production_archives WHERE project_id=? AND language_project_id IN (SELECT value FROM json_each(?)) ORDER BY language_project_id, archive_number DESC")
    .bind(projectId, JSON.stringify(taskIds)).all<Row>()).results;
  if (!archives.length) return [];
  const files = (await db.prepare(`SELECT af.archive_id, af.file_version_id, af.role, v.original_name, v.version_number, pf.mime_type, filed.folder_code,
      CASE WHEN EXISTS(${liveVersionSql("v.id=af.file_version_id", "af.language_project_id", "?")}) THEN 1 ELSE 0 END AS live
    FROM deseret_archive_files af LEFT JOIN aigc_file_versions v ON v.id=af.file_version_id LEFT JOIN project_files pf ON pf.id=af.file_version_id
    LEFT JOIN aigc_files logical ON logical.id=v.file_id LEFT JOIN aigc_folders filed ON filed.id=logical.folder_id
    WHERE af.archive_id IN (SELECT value FROM json_each(?)) ORDER BY af.created_at, af.id`)
    .bind(projectId, projectId, JSON.stringify(archives.map(row => row.id))).all<Row>()).results;
  return archives.map(row => {
    const mine = files.filter(file => file.archive_id === row.id).map(file => ({ role: String(file.role), file: {
      id: String(file.file_version_id), name: String(file.original_name ?? file.file_version_id), version: Number(file.version_number ?? 0),
      mimeType: String(file.mime_type ?? ""), live: Number(file.live) === 1 } satisfies DeseretArchiveFile }));
    const project = mine.find(item => item.role === "project")?.file ?? { id: "", name: "", version: 0, mimeType: "", live: false };
    const all = mine.map(item => item.file);
    // A historical binding whose engineering file is not filed under Project files is not a valid engineering archive.
    const engineering = files.some(file => file.archive_id === row.id && file.role === "project" && file.folder_code === ENGINEERING_FOLDER);
    return {
      id: String(row.id), number: Number(row.archive_number), taskId: String(row.language_project_id), createdBy: String(row.created_by_email), createdAt: String(row.created_at),
      projectVersion: project, ...(mine.some(item => item.role === "preview") ? { preview: mine.find(item => item.role === "preview")!.file } : {}),
      materials: mine.filter(item => item.role === "material").map(item => item.file), nextSteps: String(row.next_steps ?? ""),
      valid: project.live && engineering && all.every(file => file.live),
      missing: [...new Set([...(engineering ? [] : [project.name]), ...all.filter(file => !file.live).map(file => file.name)])].filter(Boolean),
    };
  });
}

/** Live formal versions of the given tasks that may be archived, newest first. */
export async function archiveCandidates(db: Database, projectId: string, taskIds: string[], readable?: ReadableVersions): Promise<DeseretArchiveCandidate[]> {
  if (!taskIds.length) return [];
  const rows = (await db.prepare(`SELECT v.id, v.original_name, v.version_number, f.language_project_id, pf.mime_type, folder.folder_code
    FROM aigc_file_versions v JOIN aigc_files f ON f.id=v.file_id JOIN aigc_folders folder ON folder.id=f.folder_id JOIN project_files pf ON pf.id=v.id
    JOIN language_projects lp ON lp.id=f.language_project_id
    WHERE f.language_project_id IN (SELECT value FROM json_each(?)) AND pf.language_project_id=f.language_project_id AND lp.project_id=? AND pf.project_id=?
      AND pf.deleted_at IS NULL AND pf.status<>'deleted' AND ${liveLogicalFileSql("f")}${readable ? ` AND v.id IN (${readable.sql})` : ""}
    ORDER BY pf.created_at DESC, v.id LIMIT 500`).bind(JSON.stringify(taskIds), projectId, projectId, ...(readable?.values ?? [])).all<Row>()).results;
  return rows.map(row => ({ id: String(row.id), name: String(row.original_name), version: Number(row.version_number), taskId: String(row.language_project_id),
    kind: row.folder_code === ENGINEERING_FOLDER ? "project" : String(row.mime_type).startsWith("video/") ? "video" : "material" }));
}

/** Deseret editor handovers of the given tasks, newest first. */
export async function taskHandovers(db: Database, projectId: string, taskIds: string[]): Promise<DeseretTaskHandover[]> {
  if (!taskIds.length) return [];
  const rows = (await db.prepare("SELECT * FROM deseret_task_handovers WHERE project_id=? AND language_project_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, id")
    .bind(projectId, JSON.stringify(taskIds)).all<Row>()).results;
  return rows.map(row => ({
    id: String(row.handover_id), taskId: String(row.language_project_id), kind: String(row.handover_kind) as DeseretTaskHandover["kind"],
    from: String(row.from_editor_email), to: String(row.to_editor_email), ...(row.archive_id ? { archiveId: String(row.archive_id) } : {}),
    verification: String(row.verification) as DeseretTaskHandover["verification"], notes: String(row.verification_notes ?? ""),
    ...(row.verified_at ? { verifiedAt: String(row.verified_at) } : {}), createdAt: String(row.created_at),
  }));
}

export async function packageSources(db: Database, projectId: string): Promise<DeseretPackageSource[]> {
  return (await db.prepare("SELECT s.*, a.archive_number FROM deseret_package_sources s JOIN deseret_production_archives a ON a.id=s.archive_id WHERE s.project_id=? ORDER BY s.created_at, s.package_id, s.scene_id")
    .bind(projectId).all<Row>()).results.map(row => ({ packageId: String(row.package_id), sceneId: String(row.scene_id), sceneVersion: Number(row.scene_version),
      taskId: String(row.language_project_id), videoVersionId: String(row.video_version_id), archiveId: String(row.archive_id), archiveNumber: Number(row.archive_number) }));
}

/**
 * The publication gate. Every scene of the package needs a valid archive of its own task. A task with a pending
 * native handover cannot be published. After a handover verified as "missing", only an archive registered after
 * that handover counts. Returns the pinned-source rows and a guard that re-checks archive files and handovers in
 * the publish transaction. Errors name the language tasks so the lead can complete them at the gate.
 */
export async function packageSourceSelection(db: Database, input: { projectId: string; packageId: string; scenes: DeseretScene[]; sources: unknown; email: string; now: string }) {
  const sources = input.sources && typeof input.sources === "object" && !Array.isArray(input.sources) ? input.sources as Record<string, unknown> : {};
  const taskIds = [...new Set(input.scenes.map(scene => scene.languageTaskId))];
  const pending = (await db.prepare("SELECT DISTINCT language_project_id FROM handover_records WHERE status='pending' AND language_project_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(taskIds)).all<Row>()).results.map(row => String(row.language_project_id));
  if (pending.length) throw new PublicError(`Resolve the pending handover before publishing language task(s): ${pending.sort().join(", ")}.`, 409, "DESERET_HANDOVER_PENDING");
  const archives = new Map((await taskArchives(db, input.projectId, taskIds)).map(archive => [archive.id, archive]));
  const handovers = await taskHandovers(db, input.projectId, taskIds);
  // Each scene needs the lead's explicit confirmation { archiveId, sceneVersion, videoVersionId } of its current
  // version and video; a confirmation made for an earlier version or video is stale and never carried over.
  const confirmation = (sceneId: string) => {
    const value = sources[sceneId];
    return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Row).archiveId === "string" ? value as { archiveId: string; sceneVersion?: unknown; videoVersionId?: unknown } : undefined;
  };
  const missingTasks = new Set<string>(), staleScenes: string[] = [];
  for (const scene of input.scenes) {
    const confirmed = confirmation(scene.id);
    const archive = confirmed ? archives.get(confirmed.archiveId) : undefined;
    if (!archive || archive.taskId !== scene.languageTaskId || !publishableArchive(archive, handovers)) missingTasks.add(scene.languageTaskId);
    else if (confirmed!.sceneVersion !== scene.version || confirmed!.videoVersionId !== scene.fileVersionId) staleScenes.push(scene.id);
  }
  if (missingTasks.size) throw new PublicError(`Choose a valid internal production archive for language task(s): ${[...missingTasks].sort().join(", ")}.`, 409, "DESERET_ARCHIVE_REQUIRED");
  if (staleScenes.length) throw new PublicError(`Confirm the internal archive again for scene(s): ${staleScenes.join(", ")}.`, 409, "DESERET_ARCHIVE_CONFIRMATION_STALE");
  const archiveIds = [...new Set(input.scenes.map(scene => confirmation(scene.id)!.archiveId))];
  return {
    statements: input.scenes.map(scene => db.prepare("INSERT INTO deseret_package_sources(id,project_id,package_id,scene_id,scene_version,language_project_id,video_version_id,archive_id,confirmed_by_email,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(randomUUID(), input.projectId, input.packageId, scene.id, scene.version, scene.languageTaskId, scene.fileVersionId, confirmation(scene.id)!.archiveId, input.email, input.now)),
    guard: {
      sql: `NOT EXISTS(SELECT 1 FROM deseret_archive_files af WHERE af.archive_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(${liveVersionSql("v.id=af.file_version_id", "af.language_project_id", "?")}))
        AND NOT EXISTS(SELECT 1 FROM deseret_production_archives a JOIN deseret_task_handovers h
          ON h.project_id=a.project_id AND h.language_project_id=a.language_project_id
          WHERE a.id IN (SELECT value FROM json_each(?)) AND h.verification='missing' AND a.created_at<h.created_at)
        AND NOT EXISTS(SELECT 1 FROM handover_records WHERE status='pending' AND language_project_id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS(SELECT 1 FROM deseret_archive_files af JOIN aigc_file_versions v ON v.id=af.file_version_id JOIN aigc_files f ON f.id=v.file_id JOIN aigc_folders folder ON folder.id=f.folder_id
          WHERE af.archive_id IN (SELECT value FROM json_each(?)) AND af.role='project' AND folder.folder_code<>'${ENGINEERING_FOLDER}')`,
      values: [JSON.stringify(archiveIds), input.projectId, input.projectId, JSON.stringify(archiveIds), JSON.stringify(taskIds), JSON.stringify(archiveIds)],
    },
  };
}

/** The newest valid archive of a task, or null. */
export async function latestValidArchive(db: Database, projectId: string, taskId: string) {
  return (await taskArchives(db, projectId, [taskId])).find(archive => archive.valid) ?? null;
}

/** Write-transaction guard: this archive of the task still exists, every file is live, and its engineering file is filed under Project files. */
export function validArchiveGuard(archiveId: string, projectId: string, taskId: string) {
  return { sql: `EXISTS(SELECT 1 FROM deseret_production_archives WHERE id=? AND project_id=? AND language_project_id=?)
    AND NOT EXISTS(SELECT 1 FROM deseret_archive_files af WHERE af.archive_id=? AND NOT EXISTS(${liveVersionSql("v.id=af.file_version_id", "af.language_project_id", "?")}))
    AND EXISTS(SELECT 1 FROM deseret_archive_files af JOIN aigc_file_versions v ON v.id=af.file_version_id JOIN aigc_files f ON f.id=v.file_id JOIN aigc_folders folder ON folder.id=f.folder_id
      WHERE af.archive_id=? AND af.role='project' AND folder.folder_code='${ENGINEERING_FOLDER}')`,
    values: [archiveId, projectId, taskId, archiveId, projectId, projectId, archiveId] as (string | number | null)[] };
}

/**
 * The internal verification row recorded with a Deseret editor handover (planned, emergency or batch), pending the
 * incoming editor's own check: staffing and verification are separate results. The archive is chosen exactly once:
 * the named `archiveId` (a planned handover standing it in for a daily report), otherwise the newest valid one, or
 * none. The returned guard re-checks that same archive in the write transaction. Ordinary projects get nothing.
 */
export async function deseretHandoverStatements(db: Database, input: { handoverId: string; projectId: string; taskId: string; kind: DeseretTaskHandover["kind"]; fromEmail: string; toEmail: string; now: string; archiveId?: string }) {
  const none = { statements: [] as DatabaseStatement[], guard: { sql: "1=1", values: [] as (string | number | null)[] } };
  if (!await db.prepare("SELECT id FROM deseret_project_links WHERE id=?").bind(input.projectId).first()) return none;
  const archive = input.archiveId !== undefined
    ? (await taskArchives(db, input.projectId, [input.taskId])).find(item => item.id === input.archiveId && item.valid) ?? invalid("The handed-over archive is no longer a valid archive of this task.")
    : await latestValidArchive(db, input.projectId, input.taskId);
  return {
    statements: [db.prepare("INSERT INTO deseret_task_handovers(id,handover_id,project_id,language_project_id,handover_kind,from_editor_email,to_editor_email,archive_id,verification,verification_notes,verified_by_email,verified_at,created_at) VALUES(?,?,?,?,?,?,?,?,'pending','',NULL,NULL,?)")
      .bind(randomUUID(), input.handoverId, input.projectId, input.taskId, input.kind, input.fromEmail, input.toEmail, archive?.id ?? null, input.now)],
    guard: archive ? validArchiveGuard(archive.id, input.projectId, input.taskId) : none.guard,
  };
}

/**
 * The checkpoint handed over by a lead's batch editor change. On a Deseret project only the outgoing editor's own
 * latest valid (ready or frozen) checkpoint of this task qualifies, re-checked in the write transaction; a checkpoint
 * of anyone else is never selected or frozen. Ordinary projects and reviewer changes keep the existing rule.
 */
export async function batchHandoverCheckpoint(db: Database, input: { projectId: string; taskId: string; fromEmail: string; role: "editor" | "reviewer" }) {
  const deseret = input.role === "editor" && Boolean(await db.prepare("SELECT id FROM deseret_project_links WHERE id=?").bind(input.projectId).first());
  if (!deseret) {
    const checkpoint = await db.prepare("SELECT id,completeness_status FROM production_checkpoints WHERE language_project_id=? AND status IN ('ready','frozen') ORDER BY version_number DESC LIMIT 1").bind(input.taskId).first<Row>();
    return { checkpoint, guard: { sql: "1=1", values: [] as (string | number | null)[] } };
  }
  const checkpoint = await db.prepare("SELECT id,completeness_status,updated_at FROM production_checkpoints WHERE language_project_id=? AND editor_email=? AND status IN ('ready','frozen') ORDER BY version_number DESC LIMIT 1").bind(input.taskId, input.fromEmail).first<Row>();
  return { checkpoint, guard: checkpoint
    ? { sql: "EXISTS(SELECT 1 FROM production_checkpoints WHERE id=? AND language_project_id=? AND editor_email=? AND status IN ('ready','frozen') AND updated_at=?) AND NOT EXISTS(SELECT 1 FROM production_checkpoints WHERE language_project_id=? AND editor_email=? AND status IN ('ready','frozen') AND version_number>(SELECT version_number FROM production_checkpoints WHERE id=?))",
      values: [String(checkpoint.id), input.taskId, input.fromEmail, String(checkpoint.updated_at), input.taskId, input.fromEmail, String(checkpoint.id)] as (string | number | null)[] }
    : { sql: "NOT EXISTS(SELECT 1 FROM production_checkpoints WHERE language_project_id=? AND editor_email=? AND status IN ('ready','frozen'))", values: [input.taskId, input.fromEmail] as (string | number | null)[] } };
}

/** Read rule: the current editor of a task may read every version archived for that task. */
export const archivedVersionReadableSql = "EXISTS(SELECT 1 FROM deseret_archive_files archived WHERE archived.file_version_id=v.id AND archived.language_project_id=lp.id)";

/** For a planned Deseret handover without a complete checkpoint: the newest valid archive may stand in. Null otherwise. */
export async function plannedHandoverArchive(db: Database, projectId: string, taskId: string): Promise<string | null> {
  if (!await db.prepare("SELECT id FROM deseret_project_links WHERE id=?").bind(projectId).first()) return null;
  return (await latestValidArchive(db, projectId, taskId))?.id ?? null;
}
