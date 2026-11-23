import { prepareAuditStatement } from "./audit-write";
import { createHash, randomUUID } from "node:crypto";
import type { Database, DatabaseStatement } from "./database";
import { guardedMutation } from "./mutation-guard";
import { PublicError } from "../lib/security-controls";
import {uploadClaimActive,uploadClaimInterrupted} from '../lib/direct-upload-state';
import { integrationDeletionInventory } from "./deseret-integration-deletion";

/** `video` and `language` delete one video or one language version inside a project; the parent stays. */
export type DeletionTarget = { kind: "customer" | "project" | "video" | "language"; id: string };
const isSubitem = (target: DeletionTarget) => target.kind === "video" || target.kind === "language";
/** Owner-initiated cancellation must not reach a reservation that changed after review. */
export type UploadCancelOptions = { idleSince?: string; guard?: { sql: string; values: (string | number | null)[] } };
export type UploadCancellation = { cancel(uploader: string, id: string, options?: UploadCancelOptions): Promise<unknown> };
export type DeletionActor = { email: string; accountId: string; revision: number; access: string };
export type DeletionAuthority = {
  actor: DeletionActor;
  condition: string;
  values: (string | number | null)[];
};
export type PermanentObjectStore = {
  /** Must refuse unverified environments and unsupported native object versioning. */
  assertReady(locations?: readonly { provider: string; bucket: string; endpoint: string; region?: string; prefix?: string }[]): Promise<void>;
  /** Removes every storage-native version and delete marker for this exact owned key. */
  purge(key: string): Promise<void>;
  abortMultipart?(key: string, uploadId: string): Promise<void>;
  assertOwned?(key: string, claims: readonly { metadataKey: string; owner: string }[]): Promise<void>;
};
type Row = Record<string, string | number | null>;
type RecordEntry = { table: string; selector: Row };
type Rehome = { fileId: string; versionIds: string[]; fromTaskId: string; toTaskId: string; toVideoId: string; toFolderId: string };
type LinkOriginal = { id: string; fileId: string; folderId: string; versionId: string; relation: string };
type Inventory = { target: DeletionTarget; name: string; revision: number; scopes: string[]; checks: string[]; records: RecordEntry[]; objects: string[]; locations: { provider: string; bucket: string; endpoint: string }[]; summary: DeletionSummary; disclosure: DeletionDisclosure; hash: string; rehome: Rehome[]; links: LinkOriginal[] };
export type DeletionSummary = { projects: number; tasks: number; records: number; files: number; objects: number; retainedObjects: number; reports: number; quality: number; deliveries: number; handovers: number; deseretProjectIds?: { externalId: string; nativeId: string }[]; parentProjectId?: string; shared?: number; unlinkShared?: string[] };
/** Metadata only: never object keys, signed URLs, payload bodies or authority guards. */
export type DeletionBlocker = { type: "upload" | "temporary_upload" | "legacy_upload" | "analysis" | "translation" | "delivered" | "archived" | "shared_folder" | "shared_file" | "project_deletion" | "integration"; id: string; object: string; owner: string; state: string; startedAt: string; updatedAt: string; action: "cancel_upload" | "ask_uploader" | "wait_for_upload" | "wait_for_cleanup" | "ask_administrator" | "wait_for_analysis" | "archive_instead" | "already_archived" | "resolve_relationship" | "wait_for_project_deletion"; availableAt?: string };
export type FileReference = { kind: "quality" | "quality_report" | "final" | "final_material" | "report" | "delivery" | "share"; number?: number };
type Listed<T> = { items: T[]; total: number };
export type DeletionDisclosure = {
  files: Listed<{ id: string; name: string; version: number; uploader: string; createdAt: string; size: number; references: FileReference[] }>;
  temporaryFiles: Listed<{ id: string; name: string; uploader: string; createdAt: string; expiresAt: string; size: number }>;
  pendingCleanups: Listed<{ id: string; name: string; uploader: string; state: string; updatedAt: string }>;
  retained: Listed<{ name: string }>;
  /**
   * Video or language deletion only: content shared with other scopes; an original another scope uses is never
   * destroyed. `link` (optional): this target's link to an original owned elsewhere. Ticked (`unlinkShared`): the
   * link is cleaned up. Not ticked: it is kept as a traceable history entry on that original. `kept` (not optional):
   * this target's file still used by exactly one other language of the project, kept with all versions and
   * references, moved to that language and recorded in its history.
   */
  shared: Listed<SharedItem>;
};
export type SharedItem = { id: string; kind: "link" | "kept"; optional: boolean; name: string; owner: "language" | "video" | "project"; ownerName: string };
export type DeletionPreview = { target: DeletionTarget; name: string; revision: number; previewHash: string; summary: DeletionSummary; disclosure: DeletionDisclosure; availability: { enabled: boolean; reason?: string } };
export type DeletionRequest = DeletionTarget & { submissionId: string; revision: number; previewHash: string; confirmationName: string; unlinkShared?: string[] };
export type DeletionStatus = { id: string; target: DeletionTarget; state: string; summary: DeletionSummary; completedObjects: number; totalObjects: number; errorCode: string | null };
type Job = Row & { id: string; target_kind: DeletionTarget["kind"]; target_id: string; actor_email: string; actor_account_id: string; actor_revision: number; target_revision: number; preview_hash: string; target_name: string; state: string; summary_json: string };
const emptySummary = (): DeletionSummary => ({ projects: 0, tasks: 0, records: 0, files: 0, objects: 0, retainedObjects: 0, reports: 0, quality: 0, deliveries: 0, handovers: 0 });
const idList = (values: string[]) => JSON.stringify([...new Set(values)].sort());
const inList = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;
const ids = (rows: Row[], column = "id") => rows.map(row => String(row[column] ?? "")).filter(Boolean);
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = (target: DeletionTarget) => `${target.kind}:${target.id}`;
function targetValid(target: DeletionTarget) {
  if (!target || !["customer", "project", "video", "language"].includes(target.kind) || typeof target.id !== "string" || !target.id || target.id.length > 200) throw new PublicError("Select a valid record.", 400, "INVALID_DELETION_TARGET");
}
function fail(message: string, code: string, status = 409): never { throw new PublicError(message, status, code); }
/** Carries every current blocker so the reviewer sees all of them, not only the first. */
export class DeletionBlockedError extends PublicError {
  constructor(message: string, code: string, readonly blockers: DeletionBlocker[]) { super(message, 409, code); }
}
/** A reservation must be idle this long before the project owner may cancel another person's upload. */
export const IDLE_UPLOAD_CANCEL_MS = 60 * 60000;
/** Owned cleanup normally finishes within one sweep; older pending cleanup needs operator reconciliation. */
export const CLEANUP_OVERDUE_MS = 15 * 60000;
/** Delivered or archived history is protected; formal records alone no longer block project deletion. */
export const protectedProjectStatuses = ["已交付", "已归档"];
const listLimit = 200;
function listed<T>(items: T[]): Listed<T> { return { items: items.slice(0, listLimit), total: items.length }; }
const parsed = (text: unknown): unknown => { try { return JSON.parse(String(text ?? "")); } catch { return null; } };
const time = (value: unknown) => Date.parse(String(value ?? ""));
const text = (value: unknown) => value === null || value === undefined ? "" : String(value);
function uploadName(row: Row) {
  const file = (parsed(row.payload_json) as { file?: { name?: unknown } } | null)?.file;
  return typeof file?.name === "string" ? file.name.slice(0, 255) : "";
}
export function uploadScopes(row: Row) {
  const value = parsed(row.scopes_json);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
/** Live claims and recent activity are never cancelled by someone else; time alone never deletes. */
function uploadAction(row: Row, viewer: string, target: DeletionTarget, now: number): Pick<DeletionBlocker, "action" | "availableAt"> {
  const updated = time(row.updated_at), lease = time(row.lease_expires_at), state = String(row.state);
  if (!["created", "uploading", "verifying"].includes(state) || !(time(row.expires_at) > now)) return { action: now - updated >= CLEANUP_OVERDUE_MS ? "ask_administrator" : "wait_for_cleanup" };
  const idle = !(lease > now) && now - updated >= IDLE_UPLOAD_CANCEL_MS;
  const claim={claim_id:text(row.claim_id),lease_expires_at:text(row.lease_expires_at)};
  if(uploadClaimActive(claim,now))return {action:'wait_for_upload'};
  if(uploadClaimInterrupted(claim,now))return {action:'ask_administrator'};
  if (state === "verifying") return { action: idle ? "ask_administrator" : "wait_for_upload" };
  if (target.kind !== "project") return { action: "ask_uploader" };
  if (row.actor_email === viewer || idle) return { action: "cancel_upload" };
  const availableAt = Math.max(updated + IDLE_UPLOAD_CANCEL_MS, Number.isFinite(lease) ? lease : 0);
  return { action: "ask_uploader", ...(Number.isFinite(availableAt) ? { availableAt: new Date(availableAt).toISOString() } : {}) };
}
const recordTables = new Set(["deseret_material_tasks", "deseret_inbox", "deseret_outbox", "deseret_handoff_history", "deseret_production_archives", "deseret_archive_files", "deseret_package_sources", "deseret_task_handovers", "deseret_project_links", "direct_upload_sessions", "upload_sessions", "share_access_sessions", "share_links", "reviews", "production_checkpoint_files", "checkpoint_environment_snapshots", "production_checkpoint_drafts", "production_checkpoints", "production_final_submission_files", "production_final_submissions", "production_flow_files", "production_flow_events", "production_staged_files", "production_submission_receipts", "task_material_links", "asset_lineage", "aigc_file_operations", "aigc_file_previews", "aigc_file_versions", "aigc_files", "project_files", "aigc_storage_objects", "aigc_folders", "quality_rounds", "deliveries", "feedback", "handover_records", "language_assignment_history", "material_standards", "publish_records", "versions", "notifications", "project_request_analyses", "project_request_documents", "project_request_revisions", "project_requests", "business_name_translations", "language_projects", "project_videos", "projects", "client_profiles", "clients"]);

/** Admission is persisted before external uploads begin. Crashed/unknown operations stay blocking. */
export async function withBusinessOperation<T>(db: Database, scopes: string[], actorEmail: string, work: () => Promise<T>): Promise<T> {
  const selected = [...new Set(scopes)].filter(Boolean);
  if (!selected.length) return work();
  const operation = randomUUID(), now = new Date().toISOString();
  await guardedMutation(db, `NOT EXISTS (SELECT 1 FROM business_deletion_locks WHERE ${inList("scope_id")})`, [idList(selected)], selected.map(key => db.prepare("INSERT INTO business_deletion_operations(id,operation_id,scope_id,actor_email,created_at) VALUES(?,?,?,?,?)").bind(randomUUID(), operation, key, actorEmail, now)));
  try { return await work(); }
  finally { await db.prepare("DELETE FROM business_deletion_operations WHERE operation_id=?").bind(operation).run(); }
}

export async function assertBusinessAvailable(db: Database, scopes: string[]) {
  if (scopes.length && await db.prepare(`SELECT 1 FROM business_deletion_locks WHERE ${inList("scope_id")} LIMIT 1`).bind(idList(scopes)).first()) fail("Record is being permanently deleted or no longer exists.", "BUSINESS_DELETED", 404);
}

/** Scope IDs originate from persisted relationships, never an unverified client-supplied parent. */
export async function businessScopes(db: Database, input: { customerId?: string; projectId?: string; taskId?: string; fileId?: string; folderId?: string; requestId?: string }) {
  const out = new Set<string>();
  if (input.customerId) out.add(`customer:${input.customerId}`);
  const projects = new Set<string>();
  if (input.projectId) projects.add(input.projectId);
  // A video or language deletion locks only its own scopes; work in sibling scopes stays available.
  const addTask = async (taskId: string) => {
    const row = await db.prepare("SELECT project_id,video_id FROM language_projects WHERE id=?").bind(taskId).first<Row>();
    out.add(`language:${taskId}`); if (row?.video_id) out.add(`video:${row.video_id}`); if (row?.project_id) projects.add(String(row.project_id));
  };
  if (input.taskId) await addTask(input.taskId);
  if (input.fileId) {
    const rows = (await db.prepare("SELECT project_id FROM project_files WHERE id=? OR id IN (SELECT id FROM aigc_file_versions WHERE file_id=?)").bind(input.fileId, input.fileId).all<Row>()).results;
    ids(rows, "project_id").forEach(id => projects.add(id));
    for (const row of (await db.prepare("SELECT language_project_id FROM project_files WHERE id=? OR id IN (SELECT id FROM aigc_file_versions WHERE file_id=?)").bind(input.fileId, input.fileId).all<Row>()).results) if (row.language_project_id) await addTask(String(row.language_project_id));
  }
  if (input.folderId) {
    const row = await db.prepare("SELECT project_id,client_id,language_project_id,video_id FROM aigc_folders WHERE id=?").bind(input.folderId).first<Row>();
    if (row?.project_id) projects.add(String(row.project_id)); if (row?.client_id) out.add(`customer:${row.client_id}`);
    if (row?.language_project_id) await addTask(String(row.language_project_id)); if (row?.video_id) out.add(`video:${row.video_id}`);
  }
  if (input.requestId) { const row = await db.prepare("SELECT client_id,project_id FROM project_requests WHERE id=?").bind(input.requestId).first<Row>(); if (row?.client_id) out.add(`customer:${row.client_id}`); if (row?.project_id) projects.add(String(row.project_id)); }
  for (const id of projects) {
    out.add(`project:${id}`);
    const row = await db.prepare("SELECT client_id FROM projects WHERE id=?").bind(id).first<Row>();
    if (row?.client_id) out.add(`customer:${row.client_id}`);
  }
  return [...out];
}

/** All public methods perform current authorization. Storage cleanup never reports partial work as success. */
export function createBusinessDeletionService(deps: {
  db: Database;
  storage: PermanentObjectStore;
  authority(email: string, target: DeletionTarget): Promise<DeletionAuthority>;
  /** The existing owner-scoped upload cancellation; it aborts parts and removes exact temporary objects. */
  uploads?: UploadCancellation;
  now?: () => number;
  /** Recomputes the parent project's summary after a video or language deletion. */
  parentSummary?(projectId: string): DatabaseStatement;
}) {
  const { db, storage } = deps, clock = deps.now ?? Date.now;
  const rows = async (table: string, condition: string, values: (string | number | null)[] = []) => (await db.prepare(`SELECT * FROM ${table} WHERE ${condition}`).bind(...values).all<Row>()).results;
  const selected = (table: string, field: string, values: string[]) => rows(table, inList(field), [idList(values)]);
  async function inventory(target: DeletionTarget, viewer: string): Promise<Inventory> {
    targetValid(target);
    const sub = isSubitem(target);
    const root = await db.prepare(`SELECT * FROM ${target.kind === "customer" ? "clients" : target.kind === "project" ? "projects" : target.kind === "video" ? "project_videos" : "language_projects"} WHERE id=?`).bind(target.id).first<Row>();
    if (!root || root.deleted_at) fail("Record not found or access denied.", "BUSINESS_DELETED", 404);
    // A video or language is deleted inside its parent project, which itself is never deleted or soft-deleted.
    const parent = sub ? await db.prepare("SELECT * FROM projects WHERE id=?").bind(root.project_id).first<Row>() : root;
    if (!parent || parent.deleted_at) fail("Record not found or access denied.", "BUSINESS_DELETED", 404);
    const subVideo = target.kind === "video" ? root : target.kind === "language" ? await db.prepare("SELECT * FROM project_videos WHERE id=?").bind(root.video_id).first<Row>() : null;
    const rootName = target.kind === "language" ? `${text(subVideo?.name)} · ${text(root.language)}` : String(root.name);
    const now = clock();
    // Collected in the historical check order: the first entry keeps the response code unchanged.
    const blocked: { code: string; message: string; blocker: DeletionBlocker }[] = [];
    const block = (code: string, message: string, blocker: Omit<DeletionBlocker, "startedAt" | "updatedAt" | "owner" | "state"> & Partial<DeletionBlocker>) => blocked.push({ code, message, blocker: { owner: "", state: "", startedAt: "", updatedAt: "", ...blocker } });
    // The other scope may be invisible to this reviewer: name only the kind of relationship.
    const shared = (kind: "folder" | "file") => ({ type: `shared_${kind}` as const, id: `shared-${blocked.length + 1}`, object: "", action: "resolve_relationship" as const });
    const data = new Map<string, Row[]>();
    const collect = async (table: string, condition: string, values: (string | number | null)[] = []) => { const result = await rows(table, condition, values); data.set(table, result); return result; };
    const collectIds = (table: string, field: string, values: string[]) => collect(table, inList(field), [idList(values)]);
    const projects = target.kind === "customer" ? await collect("projects", "client_id=?", [target.id]) : [parent]; data.set("projects", sub ? [] : projects);
    const projectIds = ids(projects);
    const languages = target.kind === "language" ? [root] : target.kind === "video" ? await rows("language_projects", "video_id=?", [target.id]) : await collectIds("language_projects", "project_id", projectIds);
    data.set("language_projects", languages);
    const taskIds = ids(languages);
    // In a Deseret-linked project, only videos and languages the integration actually references are protected;
    // ones AIGC added later and never linked can be deleted on their own. An unreadable integration record refuses.
    const integration = sub ? await db.prepare("SELECT native_video_ids,native_task_ids,state_json FROM deseret_project_links WHERE id=?").bind(parent.id).first<Row>() : null;
    if (integration && await integrationReferences(integration, taskIds, target.kind === "video" ? [target.id] : []))
      block("DESERET_SUBITEM_PROTECTED", "Videos and languages of a Deseret project are kept in step with the publisher and cannot be deleted one by one here.", { type: "integration", id: String(parent.id), object: text(parent.name), action: "resolve_relationship" });
    const integrationLinks = sub ? [] : await collectIds("deseret_project_links", "id", projectIds);
    const integrationTasks = sub ? [] : await collectIds("deseret_material_tasks", "project_id", projectIds);
    if (!sub) {
      for (const table of ["deseret_inbox", "deseret_outbox", "deseret_handoff_history", "deseret_production_archives", "deseret_package_sources", "deseret_task_handovers"]) await collectIds(table, "project_id", projectIds);
      await collectIds("deseret_archive_files", "archive_id", ids(data.get("deseret_production_archives") ?? []));
    }
    const integrationStorage = integrationDeletionInventory(integrationTasks);
    if (integrationStorage.uploads.length && !storage.abortMultipart) fail("Multipart cleanup is unavailable in this storage adapter.", "PERMANENT_DELETION_NOT_VERIFIED");
    if (integrationStorage.objects.length && !storage.assertOwned) fail("Integration ownership checks are unavailable.", "PERMANENT_DELETION_NOT_VERIFIED");
    // A project deletion releases its customer scope once recorded; its project tombstone still holds every
    // row it will remove. The customer waits until that cleanup finishes instead of failing later at commit.
    if (target.kind === "customer") for (const row of await db.prepare(`SELECT j.id,j.target_name,j.actor_email,j.state,j.created_at,j.updated_at FROM business_deletion_jobs j WHERE j.target_kind='project' AND j.state<>'complete' AND EXISTS(SELECT 1 FROM business_deletion_locks l WHERE l.job_id=j.id AND ${inList("l.scope_id")}) ORDER BY j.created_at,j.id`).bind(idList(projectIds.map(id => `project:${id}`))).all<Row>().then(result => result.results))
      block("PROJECT_DELETION_UNFINISHED", "A project deletion in this customer is unfinished. Wait for it to complete before deleting the customer.", { type: "project_deletion", id: String(row.id), object: text(row.target_name), owner: text(row.actor_email), state: text(row.state), startedAt: text(row.created_at), updatedAt: text(row.updated_at), action: "wait_for_project_deletion" });
    const directScopes=[...projectIds.map(id=>`project:${id}`),...(target.kind==="customer"?[`customer:${target.id}`]:[])];
    // MySQL may materialize a JSON_TABLE derived table over this correlated column and evaluate it with an
    // empty document, failing the whole preview with ER_INVALID_JSON_TEXT_IN_PARAM. Matching the encoded
    // token keeps the check on a bound JSON list only, so the optimizer plan cannot change the outcome.
    // A video or language: uploads aimed at its tasks, files or folders (checked once the folders are known).
    let directUploads: Row[] = sub ? [] : await collect("direct_upload_sessions", `EXISTS (SELECT 1 FROM json_each(?) wanted WHERE instr(direct_upload_sessions.scopes_json, json_quote(wanted.value)) > 0)`, [idList(directScopes)]);
    const blockUploads = () => { for (const row of directUploads.filter(item => !item.cleaned_at)) block("BUSINESS_OPERATION_IN_PROGRESS", "Direct uploads are still active or await owned-resource cleanup. Finish or reconcile them first.", { type: "upload", id: String(row.id), object: uploadName(row), owner: text(row.actor_email), state: text(row.state), startedAt: text(row.created_at), updatedAt: text(row.updated_at), ...uploadAction(row, viewer, target, now) }); };
    if (!sub) blockUploads();
    const videos = target.kind === "video" ? [root] : target.kind === "language" ? [] : await collectIds("project_videos", "project_id", projectIds);
    data.set("project_videos", videos);
    const requests = sub ? [] : await collect("project_requests", target.kind === "customer" ? "client_id=?" : inList("project_id"), [target.kind === "customer" ? target.id : idList(projectIds)]);
    data.set("project_requests", requests);
    const folderSeeds = sub
      ? [...ids(videos, "root_folder_id"), ...ids(await rows("aigc_folders", `${inList("language_project_id")}${target.kind === "video" ? " OR video_id=?" : ""}`, [idList(taskIds), ...(target.kind === "video" ? [target.id] : [])]))]
      : [...ids(projects, "root_folder_id"), ...ids(videos, "root_folder_id"), ...(target.kind === "customer" && root.root_folder_id ? [String(root.root_folder_id)] : []), ...ids(await rows("aigc_folders", `${inList("project_id")} OR ${inList("language_project_id")} OR ${inList("video_id")}${target.kind === "customer" ? " OR client_id=?" : ""}`, [idList(projectIds), idList(taskIds), idList(ids(videos)), ...(target.kind === "customer" ? [target.id] : [])]))];
    const folders = (await db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM aigc_folders WHERE ${inList("id")} UNION SELECT f.id FROM aigc_folders f JOIN tree ON f.parent_folder_id=tree.id) SELECT f.* FROM aigc_folders f JOIN tree ON tree.id=f.id`).bind(idList(folderSeeds)).all<Row>()).results;
    // Workspace/library parents may contain unrelated material. They are never inferred from path/name.
    const clientId = target.kind === "customer" ? target.id : String(parent.client_id);
    // A language's production folders carry its own video's id; only another video is foreign.
    const ownVideo = target.kind === "video" ? target.id : target.kind === "language" ? text(root.video_id) : "";
    const foreignVideo = (row: Row) => sub && Boolean(row.video_id) && String(row.video_id) !== ownVideo;
    if (folders.some(row => String(row.node_type).startsWith("library") || (row.client_id && String(row.client_id) !== clientId) || (row.project_id && !projectIds.includes(String(row.project_id))) || (row.language_project_id && !taskIds.includes(String(row.language_project_id))) || foreignVideo(row))) block("SHARED_FOLDER_SCOPE", "A folder contains another business scope. Review the shared relationship before deletion.", shared("folder"));
    data.set("aigc_folders", folders);
    const folderIds = ids(folders);
    let logical = await collect("aigc_files", `source<>'internal' AND (${inList("language_project_id")} OR ${inList("folder_id")})`, [idList(taskIds), idList(folderIds)]);
    if (logical.some(row => row.language_project_id && !taskIds.includes(String(row.language_project_id)))) block("SHARED_FILE_RECORD", "A project file belongs to a different task scope.", shared("file"));
    let fileVersions = await collectIds("aigc_file_versions", "file_id", ids(logical));
    let projectFiles = await collect("project_files", sub ? `${inList("language_project_id")} OR ${inList("id")}` : `${inList("project_id")} OR ${inList("language_project_id")} OR ${inList("id")}`, sub ? [idList(taskIds), idList(ids(fileVersions))] : [idList(projectIds), idList(taskIds), idList(ids(fileVersions))]);
    const rehome: Rehome[] = [], sharedItems: SharedItem[] = [];
    let keptVersionIds = new Set<string>();
    if (sub) {
      const kept = await usedElsewhere(logical, fileVersions, taskIds, String(parent.id), block);
      rehome.push(...kept.rehome); sharedItems.push(...kept.items);
      const keptFiles = new Set(kept.rehome.map(item => item.fileId)), keptVersions = new Set(kept.rehome.flatMap(item => item.versionIds));
      keptVersionIds = keptVersions;
      logical = logical.filter(row => !keptFiles.has(String(row.id))); data.set("aigc_files", logical);
      fileVersions = fileVersions.filter(row => !keptVersions.has(String(row.id))); data.set("aigc_file_versions", fileVersions);
      projectFiles = projectFiles.filter(row => !keptVersions.has(String(row.id))); data.set("project_files", projectFiles);
    }
    const logicalIds = ids(logical), versionIds = ids(fileVersions);
    const projectFileIds = ids(projectFiles);
    if (projectFiles.some(row => row.project_id && !projectIds.includes(String(row.project_id)))) block("SHARED_FILE_RECORD", "A file version belongs to another project.", shared("file"));
    const checkpoints = await collectIds("production_checkpoints", "language_project_id", taskIds), checkpointIds = ids(checkpoints);
    const finals = await collectIds("production_final_submissions", "language_project_id", taskIds), finalIds = ids(finals);
    const events = await collectIds("production_flow_events", "language_project_id", taskIds);
    const shares = await collect("share_links", sub ? inList("file_id") : `${inList("project_id")} OR ${inList("file_id")}`, sub ? [idList(projectFileIds)] : [idList(projectIds), idList(projectFileIds)]);
    await collectIds("share_access_sessions", "share_id", ids(shares));

    await collectIds("production_checkpoint_files", "checkpoint_id", checkpointIds);
    await collectIds("checkpoint_environment_snapshots", "checkpoint_id", checkpointIds);
    await collectIds("production_checkpoint_drafts", "language_project_id", taskIds);
    await collectIds("production_final_submission_files", "submission_id", finalIds);
    await collectIds("production_flow_files", "event_id", ids(events));
    const staged = await collectIds("production_staged_files", "language_project_id", taskIds);
    if (sub) {
      // Uploads into this video or language: by task, folder or stored language/video scope, and automatic covers by
      // the exact version or staged upload they belong to.
      const tree = [...taskIds.map(id => `language:${id}`), ...ids(videos).map(id => `video:${id}`)];
      directUploads = await rows("direct_upload_sessions", `json_extract(payload_json,'$.fields.task') IN (SELECT value FROM json_each(?)) OR json_extract(payload_json,'$.fields.languageProjectId') IN (SELECT value FROM json_each(?))
        OR json_extract(payload_json,'$.fields.folderId') IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(?) wanted WHERE instr(direct_upload_sessions.scopes_json, json_quote(wanted.value)) > 0)
        OR json_extract(payload_json,'$.fields.thumbnailForVersionId') IN (SELECT value FROM json_each(?)) OR json_extract(payload_json,'$.fields.parentUploadId') IN (SELECT value FROM json_each(?))`,
        [idList(taskIds), idList(taskIds), idList(folderIds), idList(tree), idList(versionIds), idList(ids(staged))]);
      data.set("direct_upload_sessions", directUploads);
      blockUploads();
    }
    await collectIds("production_submission_receipts", "id", [...checkpointIds, ...finalIds, ...ids(events)]);
    await collectIds("task_material_links", "language_project_id", taskIds);
    await collectIds("asset_lineage", "output_file_id", logicalIds);
    await collect("aigc_file_operations", `${inList("file_id")} OR ${inList("folder_id")}`, [idList(logicalIds), idList(folderIds)]);
    const previewTargetIds=[...new Set([...versionIds,...ids(staged)])].filter(id => !keptVersionIds.has(id));
    const previews = await collectIds("aigc_file_previews", "file_version_id", previewTargetIds);
    if (sub) {
      for (const table of ["quality_rounds", "deliveries", "feedback"]) await collectIds(table, "language_project_id", taskIds);
      data.set("versions", []);
      await collectIds("publish_records", "file_id", projectFileIds);
    } else for (const table of ["quality_rounds", "deliveries", "feedback", "versions", "publish_records"]) await collectIds(table, "project_id", projectIds);
    await collectIds("reviews", "version_id", [...projectFileIds, ...ids(data.get("versions") ?? [])]);
    await collectIds("upload_sessions", "language_project_id", taskIds);
    for (const table of ["handover_records", "language_assignment_history"]) await collectIds(table, "language_project_id", taskIds);
    if (sub) await collectIds("material_standards", "language_project_id", taskIds);
    else await collect("material_standards", `${inList("project_id")} OR ${inList("language_project_id")}${target.kind === "customer" ? " OR client_id=?" : ""}`, [idList(projectIds), idList(taskIds), ...(target.kind === "customer" ? [target.id] : [])]);
    for (const table of ["project_request_analyses", "project_request_documents", "project_request_revisions"]) await collectIds(table, "request_id", ids(requests));
    const entityIds = sub ? [target.id, ...taskIds, ...ids(videos), ...logicalIds, ...projectFileIds] : [target.id, ...projectIds, ...taskIds, ...ids(videos), ...ids(requests), ...logicalIds, ...projectFileIds];
    await collectIds("notifications", "target_id", entityIds);
    await collectIds("business_name_translations", "entity_id", entityIds);
    if (target.kind === "customer") { await collect("client_profiles", "client_id=?", [target.id]); data.set("clients", [root]); }
    const summary = emptySummary();
    if (integrationLinks.length) summary.deseretProjectIds = integrationLinks.map(row => ({ externalId: String(row.deseret_project_id), nativeId: String(row.id) }));
    summary.projects = sub ? 0 : projects.length; summary.tasks = languages.length; summary.files = projectFiles.length;
    if (sub) { summary.parentProjectId = String(parent.id); summary.shared = sharedItems.length; }
    summary.reports = checkpoints.filter(row => row.status !== "draft").length;
    summary.quality = data.get("quality_rounds")!.length; summary.deliveries = data.get("deliveries")!.length; summary.handovers = data.get("handover_records")!.length;
    // Rule change 2026-10-29: daily reports, QC rounds, finals and handovers no longer block deleting
    // an undelivered, unarchived project. Successful delivery or archiving still protects all history.
    if (target.kind === "project" || sub) {
      const historyRoot = parent;
      for (const row of sub ? data.get("publish_records") ?? [] : []) block("PROJECT_HISTORY_PROTECTED", "Published history is protected.", { type: "delivered", id: String(row.id), object: text(row.title_zh ?? row.title_en), state: text(row.status), startedAt: text(row.published_at), action: "archive_instead" });
      const archived = historyRoot.status === "已归档" ? [historyRoot] : languages.filter(row => row.status === "已归档");
      const deliveredTasks = languages.filter(row => row.status === "已交付"), listedTasks = new Set(ids(deliveredTasks));
      const historyMessage = "This project has been delivered or archived. Its history is protected; archive it instead.";
      if (archived.length) for (const row of archived) block("PROJECT_HISTORY_PROTECTED", historyMessage, { type: "archived", id: String(row.id), object: text(row.language ?? row.name), state: "已归档", updatedAt: text(row.updated_at), action: "already_archived" });
      else {
        for (const row of deliveredTasks) block("PROJECT_HISTORY_PROTECTED", historyMessage, { type: "delivered", id: String(row.id), object: text(row.language), state: "已交付", updatedAt: text(row.updated_at), action: "archive_instead" });
        for (const row of (data.get("deliveries") ?? []).filter(item => !listedTasks.has(String(item.language_project_id)))) block("PROJECT_HISTORY_PROTECTED", historyMessage, { type: "delivered", id: String(row.id), object: text(projectFiles.find(file => file.id === row.file_id)?.original_name), owner: text(row.owner_email), state: text(row.status), startedAt: text(row.delivered_at), action: "archive_instead" });
        for (const row of projectFiles.filter(file => file.status === "delivered" && !listedTasks.has(String(file.language_project_id)) && !(data.get("deliveries") ?? []).some(item => item.file_id === file.id))) block("PROJECT_HISTORY_PROTECTED", historyMessage, { type: "delivered", id: String(row.id), object: text(row.original_name), owner: text(row.uploader_email), state: "delivered", startedAt: text(row.created_at), action: "archive_instead" });
        if (historyRoot.status === "已交付" && !blocked.some(item => item.code === "PROJECT_HISTORY_PROTECTED")) block("PROJECT_HISTORY_PROTECTED", historyMessage, { type: "delivered", id: String(historyRoot.id), object: text(historyRoot.name), state: "已交付", updatedAt: text(historyRoot.updated_at), action: "archive_instead" });
      }
    }
    for (const row of data.get("project_request_analyses") ?? []) if (row.status === "processing") block("BUSINESS_OPERATION_IN_PROGRESS", "Analysis is still in progress. Finish or reconcile it first.", { type: "analysis", id: String(row.id), object: text(requests.find(request => request.id === row.request_id)?.title ?? ""), owner: text(row.created_by), state: "processing", startedAt: text(row.created_at), updatedAt: text(row.updated_at), action: "wait_for_analysis" });
    for (const row of data.get("business_name_translations") ?? []) if (row.status === "processing") block("BUSINESS_OPERATION_IN_PROGRESS", "Analysis is still in progress. Finish or reconcile it first.", { type: "translation", id: String(row.id), object: text(row.source_name), owner: text(row.updated_by), state: "processing", updatedAt: text(row.updated_at), action: "wait_for_analysis" });
    // A staged row with the same ID is the production side of a direct reservation listed above.
    const reservations = new Set(ids(directUploads.filter(row => !row.cleaned_at)));
    for (const row of staged.filter(item => (item.state === "uploading" || item.state === "cleanup_claimed") && !reservations.has(String(item.id)))) block("BUSINESS_OPERATION_IN_PROGRESS", "Uploads or submissions are still in progress. Finish or reconcile them first.", { type: "temporary_upload", id: String(row.id), object: text(row.original_name), owner: text(row.actor_email), state: text(row.state), startedAt: text(row.created_at), updatedAt: text(row.updated_at), action: now - time(row.updated_at) >= CLEANUP_OVERDUE_MS ? "ask_administrator" : row.state === "uploading" ? "wait_for_upload" : "wait_for_cleanup" });
    const legacy = await rows("upload_sessions", `${inList("language_project_id")} AND status NOT IN ('completed','cancelled','failed','expired')`, [idList(taskIds)]);
    for (const row of legacy) block("BUSINESS_OPERATION_IN_PROGRESS", "Uploads or submissions are still in progress. Finish or reconcile them first.", { type: "legacy_upload", id: String(row.id), object: text(row.original_name), owner: text((await db.prepare("SELECT email FROM accounts WHERE id=?").bind(row.account_id).first<Row>())?.email), state: text(row.status), startedAt: text(row.created_at), updatedAt: text(row.updated_at), action: now - time(row.updated_at) >= CLEANUP_OVERDUE_MS ? "ask_administrator" : "wait_for_upload" });
    // Preserve metadata needed by another scope; do not silently leave a dangling reference.
    const externalReferences = [
      ["production_checkpoint_files", inList("file_version_id"), versionIds, "checkpoint_id", checkpointIds],
      ["production_final_submission_files", inList("file_version_id"), versionIds, "submission_id", finalIds],
      ["production_flow_files", inList("file_version_id"), versionIds, "event_id", ids(events)],
      ["task_material_links", inList("material_version_id"), versionIds, "language_project_id", taskIds],
      ["asset_lineage", inList("source_version_id"), versionIds, "output_file_id", logicalIds],
      ["asset_lineage", inList("source_asset_id"), logicalIds, "output_file_id", logicalIds],
      ["aigc_files", inList("current_version_id"), versionIds, "id", logicalIds],
      ["production_staged_files", inList("committed_version_id"), versionIds, "id", ids(staged)],
      ["production_checkpoint_drafts", inList("project_file_version_id"), versionIds, "language_project_id", taskIds],
      ["production_checkpoint_drafts", inList("preview_file_version_id"), versionIds, "language_project_id", taskIds],
      ["production_checkpoints", inList("project_file_version_id"), versionIds, "id", checkpointIds],
      ["production_checkpoints", inList("preview_file_version_id"), versionIds, "id", checkpointIds],
      ["production_checkpoints", inList("manifest_file_version_id"), versionIds, "id", checkpointIds],
      ["production_final_submissions", inList("final_version_id"), versionIds, "id", finalIds],
      ["material_standards", inList("file_version_id"), versionIds, "id", ids(data.get("material_standards") ?? [])],
      ["material_standards", inList("logical_file_id"), logicalIds, "id", ids(data.get("material_standards") ?? [])],
      ["quality_rounds", inList("file_id"), projectFileIds, sub ? "language_project_id" : "project_id", sub ? taskIds : projectIds],
      ["quality_rounds", inList("report_file_id"), projectFileIds, sub ? "language_project_id" : "project_id", sub ? taskIds : projectIds],
      ["deliveries", inList("file_id"), projectFileIds, sub ? "language_project_id" : "project_id", sub ? taskIds : projectIds],
      ["feedback", inList("file_id"), projectFileIds, sub ? "language_project_id" : "project_id", sub ? taskIds : projectIds],
      ["share_links", inList("file_id"), projectFileIds, sub ? "id" : "project_id", sub ? ids(shares) : projectIds],
      ["publish_records", inList("file_id"), projectFileIds, sub ? "id" : "project_id", sub ? ids(data.get("publish_records") ?? []) : projectIds],
    ] as const;
    for (const [table, test, source, owner, deleting] of externalReferences) if ((await rows(table, `${test} AND NOT (${inList(`COALESCE(${owner}, '')`)})`, [idList(source), idList(deleting)])).length) block("SHARED_FILE_RECORD", "A file record is still used outside this customer. Resolve the relationship before deletion.", shared("file"));
    if ((await selected("asset_collection_files", "file_id", logicalIds)).length) block("SHARED_FILE_RECORD", "An asset collection still owns a file record.", shared("file"));
    if ((await rows("asset_collections", `${inList("final_file_id")} OR ${inList("cover_file_id")}`, [idList(logicalIds), idList(logicalIds)])).length) block("SHARED_FILE_RECORD", "An asset collection still uses a project file.", shared("file"));
    if (blocked.some(item => item.code === "PROJECT_HISTORY_PROTECTED")) for (const item of blocked) if (item.blocker.action === "cancel_upload") { item.blocker.action = "ask_uploader"; delete item.blocker.availableAt; }
    const outgoing = sub ? await outgoingLinks(data, new Set(versionIds), new Set(projectFileIds)) : { items: [], links: [] };
    sharedItems.push(...outgoing.items);
    if (sharedItems.length > listLimit) block("SHARED_ITEMS_TOO_MANY", `More than ${listLimit} shared items cannot be reviewed one by one. Remove some of these links where they are used, then review again.`, shared("file"));
    if (blocked.length) throw new DeletionBlockedError(blocked[0].message, blocked[0].code, blocked.slice(0, listLimit).map(item => item.blocker));
    const stores = await selected("aigc_storage_objects", "id", ids(fileVersions, "storage_object_id"));
    const candidates = [...new Set([...projectFiles, ...previews, ...staged, ...stores, ...(data.get("project_request_documents") ?? [])].map(row => String(row.object_key ?? "")).filter(Boolean).concat(integrationStorage.objects.map(item => item.key)))];
    const excluded = new Map<string, string[]>([["project_files", projectFileIds], ["aigc_file_previews", previewTargetIds], ["production_staged_files", ids(staged)], ["aigc_storage_objects", ids(stores)], ["project_request_documents", ids(data.get("project_request_documents") ?? [])]]);
    const retained = new Set<string>();
    for (const [table, deletingIds] of excluded) for (const row of await rows(table, `${inList("object_key")} AND NOT (${inList(table === "aigc_file_previews" ? "file_version_id" : "id")})`, [idList(candidates), idList(deletingIds)])) retained.add(String(row.object_key));
    const sharedStores = await rows("aigc_file_versions", `${inList("storage_object_id")} AND NOT (${inList("id")})`, [idList(ids(stores)), idList(versionIds)]);
    const sharedStoreIds = new Set(ids(sharedStores, "storage_object_id"));
    for (const row of stores) if (sharedStoreIds.has(String(row.id))) retained.add(String(row.object_key));
    data.set("aigc_storage_objects", stores.filter(row => !sharedStoreIds.has(String(row.id))));
    const objects = [...new Set([...candidates, ...integrationStorage.objects.map(item => item.key)])].filter(key => !retained.has(key)).sort();
    const records: RecordEntry[] = [];
    for (const table of recordTables) for (const row of data.get(table) ?? []) {
      const selector: Row = table === "production_final_submission_files" ? { submission_id: row.submission_id, file_version_id: row.file_version_id, category: row.category } : table === "aigc_file_previews" ? { file_version_id: row.file_version_id } : table === "share_access_sessions" ? { token_hash: row.token_hash } : table === "client_profiles" ? { client_id: row.client_id } : { id: row.id };
      records.push({ table, selector });
    }
    if (records.length > 100000 || objects.length > 20000) fail("The deletion exceeds the bounded online operation size.", "DELETION_TOO_LARGE");
    summary.records = records.length; summary.objects = objects.length; summary.retainedObjects = retained.size;
    // A video or language locks its own scopes only; the parent project and customer stay available.
    // Every deletion locks its whole tree, including the videos and languages below a project or customer, so a
    // deletion inside it and a deletion of it never run at once (even when the inner one has no files).
    const tree = [...taskIds.map(id => `language:${id}`), ...ids(videos).map(id => `video:${id}`)];
    const scopes = [scope(target), ...tree, ...(sub ? rehome.map(item => `file:${item.fileId}`) : projectIds.map(id => `project:${id}`)), ...versionIds.map(id => `version:${id}`), ...projectFileIds.map(id => `version:${id}`), ...logicalIds.map(id => `file:${id}`), ...[...new Set([...objects, ...retained])].map(key => `object:${createHash("sha256").update(key).digest("hex")}`)];
    // Stored objects kept for another reference are locked too: two deletions sharing an object are serialized, and
    // the later one, reviewed again, is the last reference and purges it.
    if (target.kind === "project") scopes.push(`customer:${root.client_id}`);
    const hashRows = [...data].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, values.map(value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    const locations = [...stores.filter(row => objects.includes(String(row.object_key))).map(row => ({ provider: String(row.provider), bucket: String(row.bucket_name), endpoint: String(row.endpoint_url ?? "") })), ...integrationStorage.objects.map(item => item.location)];
    const references = new Map<string, FileReference[]>(), refer = (id: unknown, reference: FileReference) => { if (id) references.set(String(id), [...(references.get(String(id)) ?? []), reference]); };
    const reportNumbers = new Map(checkpoints.map(row => [String(row.id), Number(row.version_number) || undefined]));
    for (const row of data.get("quality_rounds") ?? []) { refer(row.file_id, { kind: "quality", number: Number(row.round_number) || undefined }); refer(row.report_file_id, { kind: "quality_report", number: Number(row.round_number) || undefined }); }
    for (const row of finals) refer(row.final_version_id, { kind: "final" });
    for (const row of data.get("production_final_submission_files") ?? []) refer(row.file_version_id, { kind: "final_material" });
    for (const row of data.get("production_checkpoint_files") ?? []) if (checkpoints.some(item => item.id === row.checkpoint_id && item.status !== "draft")) refer(row.file_version_id, { kind: "report", number: reportNumbers.get(String(row.checkpoint_id)) });
    for (const row of data.get("deliveries") ?? []) refer(row.file_id, { kind: "delivery" });
    for (const row of shares) refer(row.file_id, { kind: "share" });
    const versionsById = new Map(fileVersions.map(row => [String(row.id), row]));
    const expiring = (row: Row) => time(row.expires_at) > now;
    const names = new Map<string, string>();
    for (const row of [...projectFiles, ...staged, ...(data.get("project_request_documents") ?? [])]) if (row.object_key && row.original_name) names.set(String(row.object_key), String(row.original_name));
    for (const row of stores) { const version = fileVersions.find(item => item.storage_object_id === row.id); if (version?.original_name) names.set(String(row.object_key), String(version.original_name)); }
    const disclosure: DeletionDisclosure = {
      files: listed(projectFiles.map(row => { const version = versionsById.get(String(row.id)); return { id: String(row.id), name: text(version?.original_name ?? row.original_name), version: Number(version?.version_number ?? row.version) || 0, uploader: text(version?.created_by ?? row.uploader_email), createdAt: text(row.created_at), size: Number(row.size_bytes) || 0, references: references.get(String(row.id)) ?? [] }; }).sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.id.localeCompare(b.id))),
      temporaryFiles: listed(staged.filter(row => row.state === "ready" && expiring(row)).map(row => ({ id: String(row.id), name: text(row.original_name), uploader: text(row.actor_email), createdAt: text(row.created_at), expiresAt: text(row.expires_at), size: Number(row.size_bytes) || 0 })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))),
      // Owned leftovers removed together with the project; they do not block deletion.
      pendingCleanups: listed(staged.filter(row => row.state === "abandoned" || row.state === "ready" && !expiring(row)).map(row => ({ id: String(row.id), name: text(row.original_name), uploader: text(row.actor_email), state: row.state === "ready" ? "expired" : text(row.state), updatedAt: text(row.updated_at) })).sort((a, b) => a.id.localeCompare(b.id))),
      retained: listed([...retained].map(key => ({ name: names.get(key) ?? "" })).sort((a, b) => a.name.localeCompare(b.name))),
      shared: listed(sharedItems.sort((a, b) => a.id.localeCompare(b.id))),
    };
    // A video or language deletion also checks, without taking them, that its project and customer are not being deleted.
    const checks = [...new Set([...scopes, ...(sub ? [`project:${parent.id}`, `customer:${parent.client_id}`, ...rehome.flatMap(item => [`language:${item.toTaskId}`, `video:${item.toVideoId}`])] : [])])];
    return { target, name: rootName, revision: Number(root.revision), scopes: [...new Set(scopes)], checks, records, objects, locations, summary, disclosure, hash: signature([hashRows, objects, disclosure, rehome]), rehome, links: outgoing.links };
  }
  /**
   * Files of a deleted video or language that another scope still uses. A file used by exactly one other language task
   * of the same project is kept (all versions, stored objects and references) and moved to that language. Anything
   * else (several users, another project, collections, standards, shares, publications) cannot be unlinked safely and
   * blocks only with that item named.
   */
  async function usedElsewhere(logical: Row[], versions: Row[], taskIds: string[], projectId: string, block: (code: string, message: string, blocker: Omit<DeletionBlocker, "startedAt" | "updatedAt" | "owner" | "state"> & Partial<DeletionBlocker>) => void) {
    const versionIds = ids(versions), deleting = idList(taskIds);
    if (!versionIds.length) return { rehome: [] as Rehome[], items: [] as SharedItem[] };
    // [table, referenced column, owning task expression] for every relation that can point at a file version.
    const relations: [string, string, string][] = [
      ["production_checkpoint_files", "file_version_id", "(SELECT language_project_id FROM production_checkpoints c WHERE c.id=r.checkpoint_id)"],
      ["production_final_submission_files", "file_version_id", "(SELECT language_project_id FROM production_final_submissions s WHERE s.id=r.submission_id)"],
      ["production_flow_files", "file_version_id", "(SELECT language_project_id FROM production_flow_events e WHERE e.id=r.event_id)"],
      ["task_material_links", "material_version_id", "r.language_project_id"],
      ["asset_lineage", "source_version_id", "(SELECT language_project_id FROM aigc_files f WHERE f.id=r.output_file_id)"],
      ["production_staged_files", "committed_version_id", "r.language_project_id"],
      ["production_checkpoint_drafts", "project_file_version_id", "r.language_project_id"], ["production_checkpoint_drafts", "preview_file_version_id", "r.language_project_id"],
      ["production_checkpoints", "project_file_version_id", "r.language_project_id"], ["production_checkpoints", "preview_file_version_id", "r.language_project_id"], ["production_checkpoints", "manifest_file_version_id", "r.language_project_id"],
      ["production_final_submissions", "final_version_id", "r.language_project_id"],
      ["quality_rounds", "file_id", "r.language_project_id"], ["quality_rounds", "report_file_id", "r.language_project_id"],
      ["deliveries", "file_id", "r.language_project_id"], ["feedback", "file_id", "r.language_project_id"],
      // Shares of a file go with the file; publications are protected history and block separately.
      ["material_standards", "file_version_id", "r.language_project_id"],
    ];
    const users = new Map<string, Set<string | null>>();
    const fileOf = new Map(versions.map(row => [String(row.id), String(row.file_id)]));
    for (const [table, column, owner] of relations) {
      for (const row of (await db.prepare(`SELECT r.${column} AS version_id, ${owner} AS task_id FROM ${table} r WHERE ${inList(`r.${column}`)} AND (${owner} IS NULL OR ${owner} NOT IN (SELECT value FROM json_each(?)))`).bind(idList(versionIds), deleting).all<Row>()).results) {
        const file = fileOf.get(String(row.version_id)); if (!file) continue;
        users.set(file, (users.get(file) ?? new Set()).add(row.task_id === null ? null : String(row.task_id)));
      }
    }
    const logicalIds = ids(logical);
    for (const row of (await db.prepare(`SELECT file_id FROM asset_collection_files WHERE ${inList("file_id")} UNION SELECT final_file_id FROM asset_collections WHERE ${inList("final_file_id")} UNION SELECT cover_file_id FROM asset_collections WHERE ${inList("cover_file_id")}`).bind(idList(logicalIds), idList(logicalIds), idList(logicalIds)).all<Row>()).results)
      users.set(String(row.file_id), (users.get(String(row.file_id)) ?? new Set()).add(null));
    const rehome: Rehome[] = [], items: SharedItem[] = [];
    for (const [fileId, owners] of users) {
      const file = logical.find(row => String(row.id) === fileId)!;
      const name = text((versions.find(row => String(row.file_id) === fileId) ?? {}).original_name ?? file.display_name);
      const [owner] = [...owners];
      const candidate = owners.size === 1 && owner ? await db.prepare("SELECT id,language,video_id FROM language_projects WHERE id=? AND project_id=?").bind(owner, projectId).first<Row>() : null;
      // Never hand a file over to a language (or video) whose own deletion is pending.
      const pendingTarget = candidate ? await db.prepare(`SELECT 1 FROM business_deletion_locks WHERE ${inList("scope_id")} LIMIT 1`).bind(idList([`language:${candidate.id}`, `video:${text(candidate.video_id)}`])).first() : null;
      const task = pendingTarget ? null : candidate;
      const from = await db.prepare("SELECT folder_code FROM aigc_folders WHERE id=?").bind(file.folder_id).first<Row>();
      const folder = task ? await db.prepare("SELECT id FROM aigc_folders WHERE language_project_id=? AND deleted_at IS NULL ORDER BY CASE WHEN folder_code=? THEN 0 ELSE 1 END, depth, id LIMIT 1").bind(task.id, text(from?.folder_code)).first<Row>() : null;
      if (!task || !folder) { block("SHARED_FILE_UNASSIGNABLE", `"${name}" is used by several scopes, another project, an asset collection or a project-level standard, so it cannot be handed over to one language. Remove that use first, then review again.`, { type: "shared_file", id: `shared-${fileId}`, object: name, action: "resolve_relationship" }); continue; }
      rehome.push({ fileId, versionIds: versions.filter(row => String(row.file_id) === fileId).map(row => String(row.id)), fromTaskId: String(file.language_project_id), toTaskId: String(task.id), toVideoId: text(task.video_id), toFolderId: String(folder.id) });
      items.push({ id: `kept:${fileId}`, kind: "kept", optional: false, name, owner: "language", ownerName: text(task.language) });
    }
    return { rehome, items };
  }
  /** This target's own rows linking originals owned elsewhere: only the link goes with the target. */
  async function outgoingLinks(data: Map<string, Row[]>, versions: Set<string>, projectFiles: Set<string>) {
    const refs: [string, string][] = [];
    for (const row of data.get("production_checkpoint_files") ?? []) refs.push([`link:production_checkpoint_files:${row.id}`, String(row.file_version_id)]);
    for (const row of data.get("production_final_submission_files") ?? []) refs.push([`link:production_final_submission_files:${row.submission_id}:${row.file_version_id}`, String(row.file_version_id)]);
    for (const row of data.get("production_flow_files") ?? []) refs.push([`link:production_flow_files:${row.id}`, String(row.file_version_id)]);
    for (const row of data.get("task_material_links") ?? []) refs.push([`link:task_material_links:${row.id}`, String(row.material_version_id)]);
    const outside = refs.filter(([, version]) => version && !versions.has(version) && !projectFiles.has(version));
    const items: SharedItem[] = [], links: LinkOriginal[] = [];
    for (const [id, version] of outside) {
      const row = await db.prepare("SELECT pf.original_name, pf.language_project_id, lp.language, v.file_id, f.folder_id FROM project_files pf LEFT JOIN language_projects lp ON lp.id=pf.language_project_id LEFT JOIN aigc_file_versions v ON v.id=pf.id LEFT JOIN aigc_files f ON f.id=v.file_id WHERE pf.id=?").bind(version).first<Row>();
      items.push({ id, kind: "link", optional: true, name: text(row?.original_name), owner: row?.language_project_id ? "language" : "project", ownerName: text(row?.language) });
      if (row?.file_id) links.push({ id, fileId: String(row.file_id), folderId: text(row.folder_id), versionId: version, relation: id.split(":")[1] });
    }
    return { items, links };
  }
  /** Whether the Deseret integration references any of these tasks or videos. Unknown structure counts as referenced. */
  async function integrationReferences(link: Row, taskIds: string[], videoIds: string[]) {
    const wanted = new Set([...taskIds, ...videoIds]);
    const list = (value: unknown) => { const items = parsed(value); return Array.isArray(items) && items.every(item => typeof item === "string") ? items as string[] : null; };
    const nativeVideos = list(link.native_video_ids), nativeTasks = list(link.native_task_ids), state = parsed(link.state_json);
    if (!nativeVideos || !nativeTasks || !state || typeof state !== "object" || Array.isArray(state)) return true;
    if (nativeVideos.some(id => videoIds.includes(id)) || nativeTasks.some(id => taskIds.includes(id))) return true;
    // Scenes, packages, files and feedback may name a task or video anywhere in the integration state.
    const strings: string[] = [];
    const walk = (value: unknown): void => { if (typeof value === "string") strings.push(value); else if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") Object.values(value).forEach(walk); };
    walk(state);
    if (strings.some(value => wanted.has(value))) return true;
    if (!taskIds.length) return false;
    const tasks = idList(taskIds);
    return Boolean(await db.prepare(`SELECT 1 FROM deseret_production_archives WHERE ${inList("language_project_id")}
      UNION ALL SELECT 1 FROM deseret_task_handovers WHERE ${inList("language_project_id")}
      UNION ALL SELECT 1 FROM deseret_package_sources WHERE ${inList("language_project_id")}
      UNION ALL SELECT 1 FROM deseret_inbox i JOIN project_files pf ON pf.id=json_extract(i.response_json,'$.id') WHERE i.sender='native-material' AND ${inList("pf.language_project_id")} LIMIT 1`).bind(tasks, tasks, tasks, tasks).first());
  }
  async function authorizedJob(email: string, jobId: string) {
    const job = await db.prepare("SELECT * FROM business_deletion_jobs WHERE id=?").bind(jobId).first<Job>();
    if (!job || job.actor_email !== email) fail("Deletion not found or access denied.", "DELETION_ACCESS_DENIED", 403);
    const authority = await deps.authority(email, { kind: job.target_kind, id: job.target_id });
    if (authority.actor.accountId !== job.actor_account_id || authority.actor.revision !== Number(job.actor_revision)) fail("Permissions changed. Deletion requires authorized recovery.", "DELETION_AUTHORITY_CHANGED", 403);
    return { job, authority };
  }
  async function status(email: string, jobId: string): Promise<DeletionStatus> {
    const { job } = await authorizedJob(email, jobId);
    const objects = await rows("business_deletion_objects", "job_id=?", [job.id]);
    return { id: job.id, target: { kind: job.target_kind, id: job.target_id }, state: String(job.state), summary: JSON.parse(job.summary_json) as DeletionSummary, completedObjects: objects.filter(row => row.state === "done").length, totalObjects: objects.length, errorCode: job.last_error ? String(job.last_error) : null };
  }
  async function preview(email: string, target: DeletionTarget): Promise<DeletionPreview> {
    targetValid(target); await deps.authority(email, target); await assertBusinessAvailable(db, [scope(target)]);
    const plan = await inventory(target, email);
    let availability: DeletionPreview["availability"] = { enabled: true };
    try {
      await storage.assertReady(plan.locations);
    } catch (error) {
      availability = { enabled: false, reason: error instanceof PublicError ? error.code : "PERMANENT_DELETION_NOT_VERIFIED" };
    }
    return { target, name: plan.name, revision: plan.revision, previewHash: plan.hash, summary: plan.summary, disclosure: plan.disclosure, availability };
  }
  async function start(email: string, request: DeletionRequest) {
    targetValid(request);
    if (!request || !/^[a-zA-Z0-9-]{16,100}$/.test(request.submissionId) || !Number.isSafeInteger(request.revision) || request.revision < 1 || !/^[a-f0-9]{64}$/.test(request.previewHash) || typeof request.confirmationName !== "string") fail("Review the deletion impact and enter the exact name.", "INVALID_DELETION_CONFIRMATION", 400);
    await storage.assertReady();
    const existing = await db.prepare("SELECT * FROM business_deletion_jobs WHERE id=?").bind(request.submissionId).first<Job>();
    if (existing) {
      const replayed = [...new Set(Array.isArray(request.unlinkShared) ? request.unlinkShared.map(String) : [])].sort();
      if (existing.actor_email !== email || existing.target_kind !== request.kind || existing.target_id !== request.id || existing.preview_hash !== request.previewHash || existing.target_name !== request.confirmationName || Number(existing.target_revision) !== request.revision
        || JSON.stringify((JSON.parse(String(existing.summary_json)) as DeletionSummary).unlinkShared ?? []) !== JSON.stringify(replayed)) fail("Submission identity does not match this operation.", "SUBMISSION_MISMATCH");
      return status(email, existing.id);
    }
    const authority = await deps.authority(email, request), before = await inventory(request, email);
    await storage.assertReady(before.locations);
    if (before.revision !== request.revision || before.hash !== request.previewHash || before.name !== request.confirmationName) fail("Record or impact changed. Review it again.", "STALE_DELETION_PREVIEW");
    // None, some or all optional links may be ticked; anything else is not a choice this plan offers.
    const unlink = [...new Set(Array.isArray(request.unlinkShared) ? request.unlinkShared.map(String) : [])].sort();
    const optional = new Set(before.disclosure.shared.items.filter(item => item.optional).map(item => item.id));
    if (unlink.some(id => !optional.has(id))) fail("Choose only this target's optional shared links.", "INVALID_SHARED_SELECTION", 400);
    const now = new Date().toISOString();
    await guardedMutation(db, `${authority.condition} AND NOT EXISTS (SELECT 1 FROM business_deletion_locks WHERE ${inList("scope_id")}) AND NOT EXISTS (SELECT 1 FROM business_deletion_operations WHERE ${inList("scope_id")})`, [...authority.values, idList(before.checks), idList(before.scopes)], [
      db.prepare("INSERT INTO business_deletion_jobs(id,target_kind,target_id,target_name,target_revision,actor_email,actor_account_id,actor_revision,preview_hash,state,summary_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?,?,?)").bind(request.submissionId, request.kind, request.id, before.name, before.revision, email, authority.actor.accountId, authority.actor.revision, before.hash, JSON.stringify({ ...before.summary, ...(isSubitem(request) ? { unlinkShared: unlink } : {}) }), now, now),
      ...before.scopes.map(key => db.prepare("INSERT INTO business_deletion_locks(scope_id,job_id,created_at) VALUES(?,?,?)").bind(key, request.submissionId, now)),
    ]);
    try {
      const current = await inventory(request, email);
      if (current.hash !== before.hash) fail("Record or impact changed. Review it again.", "STALE_DELETION_PREVIEW");
      const statements: DatabaseStatement[] = [
        ...current.records.map((record, index) => db.prepare("INSERT INTO business_deletion_records(id,job_id,table_name,selector_json,position) VALUES(?,?,?,?,?)").bind(randomUUID(), request.submissionId, record.table, JSON.stringify(record.selector), index)),
        ...current.objects.map(key => db.prepare("INSERT INTO business_deletion_objects(id,job_id,object_key,state,updated_at) VALUES(?,?,?,'pending',?)").bind(randomUUID(), request.submissionId, key, now)),
        db.prepare("UPDATE projects SET deleted_at=? WHERE id IN (SELECT substr(scope_id,9) FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'project:%')").bind(now, request.submissionId),
        ...(request.kind === "customer" ? [db.prepare("UPDATE clients SET deleted_at=?,deleted_by=?,deletion_batch_id=? WHERE id=?").bind(now, email, request.submissionId, request.id)] : []),
        db.prepare("UPDATE share_links SET enabled=0 WHERE project_id IN (SELECT substr(scope_id,9) FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'project:%')").bind(request.submissionId),
        db.prepare("UPDATE deseret_material_tasks SET state='cancelled',lease_id=NULL,lease_expires_at=NULL WHERE project_id IN (SELECT substr(scope_id,9) FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'project:%')").bind(request.submissionId),
        db.prepare("UPDATE deseret_outbox SET state='cancelled',lease_id=NULL,lease_expires_at=NULL WHERE project_id IN (SELECT substr(scope_id,9) FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'project:%')").bind(request.submissionId),
        // Traceable history on the originals: links not ticked for clean-up, and files moved to another language.
        ...current.links.filter(link => !unlink.includes(link.id)).map(link => db.prepare("INSERT INTO aigc_file_operations(file_id,folder_id,operation,actor_email,details,created_at) VALUES(?,?,'business.deleted_scope_reference_retained',?,?,?)")
          .bind(link.fileId, link.folderId, email, JSON.stringify({ target: { kind: request.kind, id: request.id, name: current.name }, relation: link.relation, versionId: link.versionId, jobId: request.submissionId }), now)),
        ...current.rehome.map(item => db.prepare("INSERT INTO aigc_file_operations(file_id,folder_id,operation,actor_email,details,created_at) VALUES(?,?,'business.moved_from_deleted_scope',?,?,?)")
          .bind(item.fileId, item.toFolderId, email, JSON.stringify({ target: { kind: request.kind, id: request.id, name: current.name }, fromTaskId: item.fromTaskId, toTaskId: item.toTaskId, jobId: request.submissionId }), now)),
        ...current.rehome.flatMap(item => [
          // The deleted language's share links to a moved file must not expose the receiving language: revoke them.
          db.prepare(`DELETE FROM share_access_sessions WHERE share_id IN (SELECT id FROM share_links WHERE ${inList("file_id")})`).bind(idList(item.versionIds)),
          db.prepare(`DELETE FROM share_links WHERE ${inList("file_id")}`).bind(idList(item.versionIds)),
          db.prepare("UPDATE aigc_files SET language_project_id=?,folder_id=?,updated_at=? WHERE id=? AND language_project_id=?").bind(item.toTaskId, item.toFolderId, now, item.fileId, item.fromTaskId),
          db.prepare(`UPDATE project_files SET language_project_id=? WHERE ${inList("id")} AND language_project_id=?`).bind(item.toTaskId, idList(item.versionIds), item.fromTaskId),
        ]),
        // A file handed over to another language is no longer part of this deletion: release its temporary lock in the
        // same transaction that moves it, so an interruption can never leave the other language's file locked.
        ...(current.rehome.length ? [db.prepare(`DELETE FROM business_deletion_locks WHERE job_id=? AND ${inList("scope_id")}`).bind(request.submissionId, idList(current.rehome.map(item => `file:${item.fileId}`)))] : []),
        db.prepare("UPDATE business_deletion_jobs SET state='pending',updated_at=? WHERE id=?").bind(now, request.submissionId),
        // The recorded job and its project, file, version and object locks now protect everything it removes.
        // Keeping the customer scope until cleanup finished hid every sibling project after a storage failure.
        ...(request.kind === "project" ? [db.prepare("DELETE FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'customer:%'").bind(request.submissionId)] : []),
        prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('business.permanent_delete_started',?,?,?,?)").bind(email, request.id, JSON.stringify({ jobId: request.submissionId, kind: request.kind, counts: current.summary }), now),
      ];
      // Hand-over targets: still live, and not under deletion, when the files move (their scopes are never locked here).
      const targets = current.rehome.map(item => ({ sql: `EXISTS(SELECT 1 FROM aigc_folders WHERE id=? AND language_project_id=? AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM language_projects WHERE id=?) AND NOT EXISTS(SELECT 1 FROM business_deletion_locks WHERE ${inList("scope_id")})`,
        values: [item.toFolderId, item.toTaskId, item.toTaskId, idList([`language:${item.toTaskId}`, `video:${item.toVideoId}`])] }));
      await guardedMutation(db, [authority.condition, ...targets.map(item => item.sql)].join(" AND "), [...authority.values, ...targets.flatMap(item => item.values)], statements);
    } catch (error) {
      await db.batch([db.prepare("DELETE FROM business_deletion_locks WHERE job_id=? AND EXISTS(SELECT 1 FROM business_deletion_jobs WHERE id=? AND state='preparing')").bind(request.submissionId, request.submissionId), db.prepare("UPDATE business_deletion_jobs SET state='rejected',last_error='PREPARATION_FAILED',updated_at=? WHERE id=? AND state='preparing'").bind(new Date().toISOString(), request.submissionId)]);
      throw error;
    }
    return status(email, request.submissionId);
  }
  async function resume(email: string, jobId: string) {
    await storage.assertReady();
    const { job, authority } = await authorizedJob(email, jobId);
    if (job.state === "complete") return status(email, jobId);
    if (!["pending", "failed", "running"].includes(job.state)) fail("Review the unfinished preparation before retrying.", "DELETION_NOT_READY");
    // No expired lease is silently stolen: an object deletion may still be in flight.
    const lease = randomUUID(), now = new Date().toISOString();
    const claimed = await db.prepare("UPDATE business_deletion_jobs SET lease_id=?,lease_expires_at=NULL,state='running',last_error='',updated_at=? WHERE id=? AND lease_id IS NULL AND state IN ('pending','failed','running') RETURNING id").bind(lease, now, jobId).first();
    if (!claimed) fail("Deletion is already running or requires interrupted-operation recovery.", "DELETION_BUSY");
    // Jobs recorded before the customer scope was released at preparation still hold it; a retry frees it.
    if (job.target_kind === "project") await db.prepare("DELETE FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'customer:%'").bind(jobId).run();
    try {
      const records = (await db.prepare("SELECT * FROM business_deletion_records WHERE job_id=? ORDER BY position").bind(jobId).all<Row>()).results;
      const integrationTaskIds = records.filter(row => row.table_name === "deseret_material_tasks").map(row => String((JSON.parse(String(row.selector_json)) as { id: string }).id));
      const integrationTasks = await selected("deseret_material_tasks", "id", integrationTaskIds);
      if (integrationTasks.length !== integrationTaskIds.length) fail("Integration cleanup records changed.", "DESERET_DELETION_INVENTORY_UNAVAILABLE");
      const integrationStorage = integrationDeletionInventory(integrationTasks);
      await storage.assertReady(integrationStorage.objects.map(item => item.location));
      const formalIds = records.filter(row => row.table_name === "project_files").map(row => String((JSON.parse(String(row.selector_json)) as { id: string }).id));
      const formalKeys = new Set((await selected("project_files", "id", formalIds)).map(row => String(row.object_key)));
      for (const upload of integrationStorage.uploads) {
        await authorizedJob(email, jobId);
        if (!storage.abortMultipart) fail("Multipart cleanup is unavailable.", "PERMANENT_DELETION_NOT_VERIFIED");
        await storage.abortMultipart(upload.key, upload.uploadId);
      }
      for (const object of await rows("business_deletion_objects", "job_id=? AND state<>'done'", [jobId])) {
        await authorizedJob(email, jobId);
        const claims = integrationStorage.objects.filter(item => item.key === object.object_key);
        if (claims.length && !formalKeys.has(String(object.object_key))) {
          if (!storage.assertOwned) fail("Integration ownership checks are unavailable.", "PERMANENT_DELETION_NOT_VERIFIED");
          await storage.assertOwned(String(object.object_key), claims);
        }
        await storage.purge(String(object.object_key));
        await db.prepare("UPDATE business_deletion_objects SET state='done',last_error='',updated_at=? WHERE id=? AND job_id=?").bind(new Date().toISOString(), object.id, jobId).run();
      }
      await authorizedJob(email, jobId);
      const deletes = records.map(record => {
        const table = String(record.table_name), selector: unknown = JSON.parse(String(record.selector_json));
        if (!recordTables.has(table) || !selector || typeof selector !== "object" || Array.isArray(selector)) throw Error("Invalid deletion manifest");
        const fields = Object.entries(selector);
        const allowed = table === "production_final_submission_files" ? ["submission_id", "file_version_id", "category"] : ["id", "file_version_id", "token_hash", "client_id"];
        if (!fields.length || fields.some(([name, value]) => !allowed.includes(name) || (value !== null && typeof value !== "string" && typeof value !== "number"))) throw Error("Invalid deletion selector");
        return db.prepare(`DELETE FROM ${table} WHERE ${fields.map(([name]) => `${name} IS ?`).join(" AND ")}`).bind(...fields.map(([, value]) => value));
      });
      await guardedMutation(db, `${authority.condition} AND EXISTS(SELECT 1 FROM business_deletion_jobs WHERE id=? AND lease_id=?) AND NOT EXISTS(SELECT 1 FROM business_deletion_objects WHERE job_id=? AND state<>'done')`, [...authority.values, jobId, lease, jobId], [...deletes,
        db.prepare("UPDATE business_deletion_jobs SET state='complete',lease_id=NULL,updated_at=? WHERE id=?").bind(new Date().toISOString(), jobId),
        db.prepare("DELETE FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'object:%'").bind(jobId),
        // After the records are gone, a file lock whose file still exists can only be a file handed over to another
        // language (including one left locked by an interrupted older preparation): release it. Deleted files keep theirs.
        db.prepare("DELETE FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'file:%' AND substr(scope_id,6) IN (SELECT id FROM aigc_files)").bind(jobId),
        // Keep the target tombstone forever; release the unrelated customer scope after project deletion.
        ...(job.target_kind === "project" ? [db.prepare("DELETE FROM business_deletion_locks WHERE job_id=? AND scope_id LIKE 'customer:%'").bind(jobId)] : []),
        db.prepare("DELETE FROM business_deletion_records WHERE job_id=?").bind(jobId),
        ...(job.target_kind === "video" || job.target_kind === "language" ? (() => {
          const parentId = String((JSON.parse(job.summary_json) as DeletionSummary).parentProjectId ?? "");
          return [
            ...(deps.parentSummary ? [deps.parentSummary(parentId)] : []),
            // A project left without language versions shows no removed people and stays open for new ones; it is never deleted.
            db.prepare("UPDATE projects SET editor_email=NULL,reviewer_email=NULL,status=CASE WHEN status='已归档' THEN status ELSE '待分配' END WHERE id=? AND NOT EXISTS(SELECT 1 FROM language_projects WHERE project_id=?)").bind(parentId, parentId),
          ];
        })() : []),
        prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('business.permanent_delete_completed',?,?,?,?)").bind(email, job.target_id, JSON.stringify({ jobId, kind: job.target_kind, counts: JSON.parse(job.summary_json) }), new Date().toISOString()),
      ]);
    } catch (error) {
      await db.prepare("UPDATE business_deletion_jobs SET state='failed',lease_id=NULL,last_error=?,updated_at=? WHERE id=? AND lease_id=?").bind(error instanceof PublicError ? error.code ?? "DELETION_REJECTED" : "DELETION_CLEANUP_FAILED", new Date().toISOString(), jobId, lease).run();
      throw error;
    }
    return status(email, jobId);
  }
  /** Called only after the previous process/worker has been proved stopped; never on a timeout. */
  async function recoverInterrupted(email: string, jobId: string, stoppedLeaseId: string) {
    await authorizedJob(email, jobId);
    if (!stoppedLeaseId) fail("Interrupted worker identity is required.", "DELETION_BUSY");
    await db.prepare("UPDATE business_deletion_jobs SET lease_id=NULL,state='failed',last_error='INTERRUPTED_WORKER',updated_at=? WHERE id=? AND lease_id=? AND state='running'").bind(new Date().toISOString(), jobId, stoppedLeaseId).run();
    return status(email, jobId);
  }
  /** Recovery tooling must prove the preparing process stopped before calling this. No object work has begun. */
  async function recoverPreparation(email: string, jobId: string) {
    const { job, authority } = await authorizedJob(email, jobId);
    if (job.state !== "preparing") fail("Only an interrupted preparation can be released.", "DELETION_NOT_READY");
    await guardedMutation(db, `${authority.condition} AND EXISTS(SELECT 1 FROM business_deletion_jobs WHERE id=? AND state='preparing') AND NOT EXISTS(SELECT 1 FROM business_deletion_records WHERE job_id=?) AND NOT EXISTS(SELECT 1 FROM business_deletion_objects WHERE job_id=?)`, [...authority.values, jobId, jobId, jobId], [
      db.prepare("DELETE FROM business_deletion_locks WHERE job_id=?").bind(jobId),
      db.prepare("UPDATE business_deletion_jobs SET state='rejected',last_error='INTERRUPTED_PREPARATION',updated_at=? WHERE id=?").bind(new Date().toISOString(), jobId),
      prepareAuditStatement(db, "INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('business.permanent_delete_preparation_recovered',?,?,?,?)").bind(email, job.target_id, JSON.stringify({ jobId }), new Date().toISOString()),
    ]);
    return status(email, jobId);
  }
  async function projectHistoryProtected(projectId: string) {
    const statuses = protectedProjectStatuses.map(() => "?").join(",");
    return Boolean(await db.prepare(`SELECT 1 FROM projects p WHERE p.id=? AND (p.status IN (${statuses}) OR EXISTS(SELECT 1 FROM language_projects lp WHERE lp.project_id=p.id AND lp.status IN (${statuses})) OR EXISTS(SELECT 1 FROM deliveries d WHERE d.project_id=p.id) OR EXISTS(SELECT 1 FROM project_files pf WHERE pf.project_id=p.id AND pf.status='delivered'))`).bind(projectId, ...protectedProjectStatuses, ...protectedProjectStatuses).first());
  }
  /** Project owner cancels an upload listed by the deletion review: their own, or another person's
   * reservation idle beyond IDLE_UPLOAD_CANCEL_MS. Reuses the uploader-scoped cancellation and the
   * background cleanup; never a direct state update, a prefix scan or another project's upload. */
  async function cancelUpload(email: string, input: { projectId: string; uploadId: string; reviewedUpdatedAt: string }) {
    const target: DeletionTarget = { kind: "project", id: input?.projectId };
    targetValid(target);
    if (!/^[a-f0-9-]{36}$/.test(String(input.uploadId)) || typeof input.reviewedUpdatedAt !== "string") fail("Review the upload before cancelling it.", "INVALID_UPLOAD_CANCELLATION", 400);
    if (!deps.uploads) fail("Upload cancellation is unavailable.", "UPLOAD_CANCEL_UNAVAILABLE", 503);
    const authority = await deps.authority(email, target); await assertBusinessAvailable(db, [scope(target)]);
    const project = await db.prepare("SELECT id,client_id,name FROM projects WHERE id=? AND deleted_at IS NULL").bind(target.id).first<Row>();
    const row = await db.prepare("SELECT * FROM direct_upload_sessions WHERE id=?").bind(input.uploadId).first<Row>();
    const projects = row ? uploadScopes(row).filter(item => item.startsWith("project:")) : [];
    if (!project || !row || projects.length !== 1 || projects[0] !== scope(target)) fail("Upload not found in this project.", "UPLOAD_NOT_IN_PROJECT", 404);
    if (row.cleaned_at || row.updated_at !== input.reviewedUpdatedAt) fail("The upload changed. Review the deletion impact again.", "STALE_DELETION_PREVIEW");
    if (uploadAction(row, email, target, clock()).action !== "cancel_upload") fail("This upload is active or not idle long enough to cancel.", "UPLOAD_NOT_IDLE");
    // Cancelling is offered only to clear a deletion blocker; delivered or archived projects cannot be deleted.
    if (await projectHistoryProtected(target.id)) fail("This project has been delivered or archived. Its uploads are not cancelled from the deletion review.", "PROJECT_HISTORY_PROTECTED");
    const uploader = String(row.actor_email), name = uploadName(row), at = new Date(clock()).toISOString();
    const audit = (action: string, extra: object = {}) => prepareAuditStatement(db, `INSERT INTO audit_logs(action,actor_email,subject,details,created_at) VALUES('${action}',?,?,?,?)`).bind(email, String(row.id), JSON.stringify({ projectId: target.id, uploader, state: row.state, lastActivity: row.updated_at, ...extra }), new Date(clock()).toISOString());
    // Recorded before the storage-side cancellation so an interrupted request still leaves a trace.
    await audit("direct_upload.owner_cancel_requested").run();
    try {
      // Admission keeps a concurrent deletion from freezing its inventory mid-cancellation; another
      // person's reservation is claimed only if it is still exactly as reviewed and idle. The owner's
      // authority is part of the same claim, so a revocation after the review stops the storage work.
      const guard = { sql: authority.condition, values: authority.values };
      await withBusinessOperation(db, [scope(target), `customer:${project.client_id}`], email, () => deps.uploads!.cancel(uploader, String(row.id), uploader === email ? { guard } : { idleSince: String(row.updated_at), guard }));
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "UPLOAD_SESSION_BUSY") {
        // A refused claim is reported as the authority change when that is what changed.
        const current = await deps.authority(email, target);
        if (current.actor.revision !== authority.actor.revision) fail("Permissions changed. Review the deletion impact again.", "DELETION_AUTHORITY_CHANGED", 403);
        fail("The upload became active again. Review the deletion impact again.", "UPLOAD_NOT_IDLE");
      }
      throw error;
    }
    await db.batch([
      audit("direct_upload.cancelled_by_project_owner"),
      ...(uploader !== email ? [// A removed uploader account cannot receive a notice; the audit entry still records the action.
      db.prepare("INSERT INTO notifications(id,recipient_email,type,title_zh,title_en,body_zh,body_en,target_type,target_id,is_read,created_at,actor_email,event_action) SELECT ?,?,'upload_cancelled','未完成上传已被项目负责人取消','Unfinished upload cancelled by the project owner',?,?,'upload',?,0,?,?,'upload.cancelled_by_owner' FROM accounts WHERE email=? LIMIT 1").bind(randomUUID(), uploader, `项目「${text(project.name)}」中的未完成上传「${name || row.id}」闲置超过 ${IDLE_UPLOAD_CANCEL_MS / 60000} 分钟，已被项目负责人取消，临时内容将被清理。需要该文件时请重新上传。`, `The unfinished upload "${name || row.id}" in project "${text(project.name)}" was idle for over ${IDLE_UPLOAD_CANCEL_MS / 60000} minutes and was cancelled by the project owner. Its temporary content will be cleaned up. Upload the file again if you still need it.`, String(row.id), at, email, uploader)] : []),
    ]);
    return { ok: true, uploadId: String(row.id), notified: uploader !== email };
  }
  return { preview, start, status, resume, recoverInterrupted, recoverPreparation, cancelUpload };
}
