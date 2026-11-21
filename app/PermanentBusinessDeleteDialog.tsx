"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import DialogSections from "./DialogSections";
import { mayLeaveDrafts, useDraftOwner, useDraftRisk } from "./useLocalDraft";
import { workspaceFetch } from "../lib/tab-session";
import { browserRandomUUID } from "../lib/browser-crypto";
import { deletionReceiptKey, isBusinessDeletionReceipt, notifyBusinessDeletionReceiptsChanged, type BusinessDeletionReceipt, type BusinessDeletionTarget } from "../lib/business-deletion-receipt";

type Target = BusinessDeletionTarget;
type Summary = { projects: number; tasks: number; files: number; objects: number; retainedObjects: number; reports: number; quality: number; deliveries: number; handovers: number; records: number };
type Listed<T> = { items: T[]; total: number };
type Reference = { kind: string; number?: number };
type Disclosure = {
  files: Listed<{ id: string; name: string; version: number; uploader: string; createdAt: string; references: Reference[] }>;
  temporaryFiles: Listed<{ id: string; name: string; uploader: string; createdAt: string; expiresAt: string }>;
  pendingCleanups: Listed<{ id: string; name: string; uploader: string; state: string; updatedAt: string }>;
  retained: Listed<{ name: string }>;
  /** Video or language deletion: content shared with other scopes. Originals used elsewhere are never deleted. */
  shared?: Listed<{ id: string; kind: "link" | "kept"; optional: boolean; name: string; owner: string; ownerName: string }>;
};
type Blocker = { type: string; id: string; object: string; owner: string; state: string; startedAt: string; updatedAt: string; action: string; availableAt?: string };
type Preview = { target: Target; name: string; revision: number; previewHash: string; summary: Summary; disclosure?: Disclosure; available?: boolean; availability?: { enabled: boolean; reason?: string } };
type Job = { id: string; target: Target; state: string; completedObjects: number; totalObjects: number; summary: Summary; errorCode?: string };
type Saved = BusinessDeletionReceipt;
type Props = { accessReviewKey?: string; accessRevoked?: boolean; targets: Target[]; locale: "zh" | "en"; close: () => void; onDeleted: (ids: string[]) => void };
const messages: Record<string, [string, string]> = {
  DESERET_DELETION_INVENTORY_UNAVAILABLE: ["对接文件的存储记录需要管理员复核。", "An administrator must reconcile the integration storage inventory."],
  PERMANENT_DELETION_NOT_VERIFIED: ["永久删除暂未开放。", "Permanent deletion is not available yet."],
  DELETION_BUSY: ["有正在进行的上传、提交或清理，请稍后重新核对。", "An upload, submission or cleanup is in progress. Review again later."],
  BUSINESS_OPERATION_ACTIVE: ["有正在进行的上传或提交，请完成后重新核对。", "An upload or submission is in progress. Complete it before reviewing again."],
  BUSINESS_OPERATION_IN_PROGRESS: ["上传等操作未结束或未清理。请核对；不再需要的上传可取消。", "Upload or operation unfinished; cleanup may be pending. Reconcile it, or cancel unwanted uploads."],
  STALE_DELETION_PREVIEW: ["客户或关联数据已变化，请重新核对影响范围。", "The record or its links changed. Review the impact again."],
  PROJECT_HISTORY_PROTECTED: ["项目已成功交付或已归档，正式历史受保护，不能永久删除。未交付的项目可直接删除。", "This project has been delivered or archived, so its history is protected and it cannot be permanently deleted. Undelivered projects can be deleted."],
  SHARED_FOLDER_SCOPE: ["项目文件夹与其他客户、项目或素材库共享，请先解除关联。", "A project folder is shared with another customer, project or the asset library. Remove the relationship first."],
  SHARED_FILE_RECORD: ["项目文件仍被其他客户、项目或素材集合使用，请先解除关联。", "A project file is still used by another customer, project or asset collection. Remove the relationship first."],
  UPLOAD_NOT_IDLE: ["该上传仍在进行或闲置时间不足，暂不能由你取消。请联系上传者。", "This upload is active or has not been idle long enough for you to cancel it. Ask the uploader."],
  UPLOAD_NOT_IN_PROJECT: ["该上传不属于此项目或已不存在，请重新核对。", "This upload is not in this project or no longer exists. Review again."],
  UPLOAD_CANCEL_UNAVAILABLE: ["当前环境无法在此取消上传，请联系管理员。", "Uploads cannot be cancelled here in this environment. Ask an administrator."],
  DIRECT_TRANSFER_DISABLED: ["当前环境无法在此取消上传，请联系管理员。", "Uploads cannot be cancelled here in this environment. Ask an administrator."],
  INVALID_SHARED_SELECTION: ["共享内容的选择已变化，请重新核对。", "The shared-content selection changed. Review it again."],
  PROJECT_DELETION_UNFINISHED: ["该客户下有项目的永久删除尚未完成。请等待项目负责人完成清理后重新核对。", "A project deletion in this customer is unfinished. Wait for the project owner to finish its cleanup, then review again."],
};
/** Video or language deletion: what each block means for that target. Never suggests deleting the whole project. */
const subitemMessages: Record<string, [string, string]> = {
  PROJECT_HISTORY_PROTECTED: ["此视频或语言版本（或其所属项目）已交付或已归档，正式历史受保护，不能永久删除。", "This video or language version (or its project) has been delivered or archived. Its history is protected and cannot be permanently deleted."],
  SHARED_FOLDER_SCOPE: ["此范围的目录与其他视频、语言版本或素材库共享，请先解除该关联后重新核对。", "A folder of this scope is shared with another video, language version or the asset library. Remove that relationship, then review again."],
  SHARED_FILE_RECORD: ["此范围的文件仍被其他客户或项目使用，请先在使用方解除引用后重新核对。", "A file of this scope is still used by another customer or project. Remove that use where it is, then review again."],
  SHARED_FILE_UNASSIGNABLE: ["下列文件同时被多个范围、其他项目、素材集合或项目级标准使用，无法移交给单个语言版本。请先在使用方解除对它的引用后重新核对。", "The files below are used by several scopes, another project, an asset collection or a project-level standard, so they cannot be handed over to one language version. Remove those uses, then review again."],
  SHARED_ITEMS_TOO_MANY: ["共享内容超过 200 项，无法逐项核对。请先在使用方解除部分引用后重新核对。", "More than 200 shared items cannot be reviewed one by one. Remove some of these links where they are used, then review again."],
  DESERET_SUBITEM_PROTECTED: ["Deseret 对接项目的视频和语言版本需与出版社保持一致，不能在这里单独删除。", "Videos and languages of a Deseret project are kept in step with the publisher and cannot be deleted one by one here."],
};
const blockerTypes: Record<string, [string, string]> = {
  upload: ["上传", "Upload"], temporary_upload: ["暂存上传", "Temporary upload"], legacy_upload: ["旧版上传", "Legacy upload"],
  analysis: ["需求分析", "Requirement analysis"], translation: ["名称翻译", "Name translation"], delivered: ["已交付", "Delivered"], archived: ["已归档", "Archived"],
  shared_folder: ["共享文件夹", "Shared folder"], shared_file: ["共享文件记录", "Shared file record"], project_deletion: ["项目永久删除", "Project deletion"], integration: ["Deseret 对接项目", "Deseret project"],
};
const blockerStates: Record<string, [string, string]> = {
  created: ["已创建", "Created"], uploading: ["上传中断或进行中", "Uploading or interrupted"], verifying: ["校验中", "Verifying"], cancelled: ["已取消，待清理", "Cancelled, cleanup pending"],
  expired: ["已过期，待清理", "Expired, cleanup pending"], ready: ["已完成，待清理", "Completed, cleanup pending"], cleanup_claimed: ["清理中", "Cleaning up"], processing: ["处理中", "Processing"],
  abandoned: ["已丢弃，待清理", "Discarded, cleanup pending"], "已交付": ["已交付", "Delivered"], "已归档": ["已归档", "Archived"], delivered: ["已交付", "Delivered"],
  pending: ["待清理", "Cleanup pending"], running: ["清理中", "Cleaning up"], failed: ["清理失败，待重试", "Cleanup failed, retry pending"], preparing: ["准备中", "Preparing"],
};
const referenceText = (reference: Reference, zh: boolean) => {
  const n = reference.number ? String(reference.number) : "";
  switch (reference.kind) {
    case "quality": return zh ? `被质检第 ${n} 轮引用` : `Referenced by QC round ${n}`;
    case "quality_report": return zh ? `质检第 ${n} 轮报告` : `QC round ${n} report`;
    case "final": return zh ? "被成片提交引用" : "Referenced by a final submission";
    case "final_material": return zh ? "成片配套文件" : "Final submission material";
    case "report": return zh ? `被日报第 ${n} 版引用` : `Referenced by daily report v${n}`;
    case "delivery": return zh ? "被交付记录引用" : "Referenced by a delivery";
    case "share": return zh ? "有分享链接" : "Has a share link";
    default: return "";
  }
};
const nonNegative = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sameTarget = (value: unknown, target: Target) => record(value)?.id === target.id && record(value)?.kind === target.kind;
const isSummary = (value: unknown) => ["projects", "tasks", "files", "objects", "retainedObjects", "reports", "quality", "deliveries", "handovers", "records"].every(key => nonNegative(record(value)?.[key]));
const isSaved = isBusinessDeletionReceipt;
const isListed = (value: unknown) => Array.isArray(record(value)?.items) && nonNegative(record(value)?.total);
const isDisclosure = (value: unknown): value is Disclosure => ["files", "temporaryFiles", "pendingCleanups", "retained"].every(key => isListed(record(value)?.[key]));
const isBlocker = (value: unknown): value is Blocker => { const row = record(value); return Boolean(row) && ["type", "id", "object", "owner", "state", "startedAt", "updatedAt", "action"].every(key => typeof row?.[key] === "string"); };
const isPreview = (value: unknown, target: Target): value is Preview => {
  const row = record(value);
  return !row?.error && sameTarget(row?.target, target) && typeof row?.name === "string" && Boolean(row.name) && nonNegative(row.revision) && Number(row.revision) > 0 && typeof row.previewHash === "string" && /^[a-f0-9]{64}$/i.test(row.previewHash) && isSummary(row.summary);
};
const isJob = (value: unknown, saved: Saved): value is Job => {
  const row = record(value);
  return !row?.error && row?.id === saved.submissionId && sameTarget(row.target, saved) && ["preparing", "pending", "running", "failed", "complete", "rejected"].includes(String(row.state)) && isSummary(row.summary) && nonNegative(row.completedObjects) && nonNegative(row.totalObjects) && Number(row.completedObjects) <= Number(row.totalObjects) && (row.state !== "complete" || row.completedObjects === row.totalObjects);
};
class DeletionResponseError extends Error {
  constructor(readonly status: number, readonly code: string, readonly blockers: Blocker[] = []) { super(code); }
}
const listedBlockers = (reason: unknown) => reason instanceof DeletionResponseError ? reason.blockers : [];
async function request(path: string, body?: object): Promise<unknown> {
  const response = await workspaceFetch(path, { method: body ? "POST" : "GET", cache: "no-store", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const value: unknown = await response.json();
  if (!response.ok) { const listed = record(value)?.blockers; throw new DeletionResponseError(response.status, typeof record(value)?.code === "string" ? String(record(value)?.code) : "", Array.isArray(listed) ? listed.filter(isBlocker) : []); }
  // A queued or otherwise unconfirmed response cannot confirm permanent cleanup.
  if (response.status === 202) throw new DeletionResponseError(202, "UNCONFIRMED");
  return value;
}
const deletionAvailable = (preview: Preview) => preview.available === true || preview.available === undefined && preview.availability?.enabled === true;
const confirmedStartRejections = new Set(["DESERET_DELETION_INVENTORY_UNAVAILABLE", "PERMANENT_DELETION_NOT_VERIFIED", "STALE_DELETION_PREVIEW", "PROJECT_HISTORY_PROTECTED", "BUSINESS_OPERATION_ACTIVE", "BUSINESS_OPERATION_IN_PROGRESS", "DELETION_BUSY", "INVALID_DELETION_CONFIRMATION", "PROJECT_DELETION_UNFINISHED"]);
/** A recorded job that stopped short of completion: say what failed and that the same receipt is the safe retry. */
const unfinishedJobText = (job: Job, zh: boolean) => {
  if (job.state === "pending") return zh ? "删除已确认，尚未开始清理。可点击“核对并继续清理”开始处理。" : "Deletion is confirmed; cleanup has not started. Select “Check and continue” to begin.";
  const progress = `${job.completedObjects} / ${job.totalObjects}`;
  switch (job.errorCode) {
    case "DESERET_DELETION_INVENTORY_UNAVAILABLE": return zh ? "对接文件的存储记录需要管理员复核，清理已暂停。请保留此记录。" : "Cleanup is paused while an administrator reconciles the integration storage inventory. Keep this receipt.";
    case "DELETION_CLEANUP_FAILED": return zh ? `存储文件清理失败（已清理 ${progress}）。记录已隐藏但尚未全部删除。可点击“核对并继续清理”安全重试，不要重新发起删除；多次失败请联系管理员。` : `Storage cleanup failed (${progress} removed). The record is hidden but not fully deleted. Select “Check and continue” to retry safely; do not start a new deletion. If it keeps failing, contact an administrator.`;
    case "INTERRUPTED_WORKER": return zh ? `上次清理被中断（已清理 ${progress}）。可点击“核对并继续清理”安全重试。` : `The previous cleanup was interrupted (${progress} removed). Select “Check and continue” to retry safely.`;
    case "PERMANENT_DELETION_NOT_VERIFIED": return zh ? "存储服务暂不可用，清理已暂停。稍后点击“核对并继续清理”重试。" : "Storage is unavailable, so cleanup is paused. Select “Check and continue” later to retry.";
    default: return zh ? `清理尚未完成（已清理 ${progress}）。请保留记录，点击“核对并继续清理”重试；多次失败请联系管理员。` : `Cleanup is incomplete (${progress} removed). Keep this receipt and select “Check and continue” to retry. If it keeps failing, contact an administrator.`;
  }
};

export default function PermanentBusinessDeleteDialog({ targets, locale, close, onDeleted, accessRevoked = false, accessReviewKey = "" }: Props) {
  const owner = useDraftOwner();
  const [index, setIndex] = useState(0), [completed, setCompleted] = useState<string[]>([]);
  const target = targets[index];
  if (!target) return null;
  return <DeleteTarget key={`${owner}:${target.kind}:${target.id}`} target={target} accessReviewKey={accessReviewKey} accessRevoked={accessRevoked} owner={owner} locale={locale} close={close} position={index} total={targets.length} completed={completed.length} finished={completed.includes(target.id)} next={() => setIndex(value => value + 1)} onDeleted={id => { setCompleted(current => current.includes(id) ? current : [...current, id]); onDeleted([id]); }} />;
}

function DeleteTarget({ target, owner, locale, close, position, total, completed, finished, next, onDeleted, accessRevoked, accessReviewKey }: { finished: boolean; accessReviewKey: string; accessRevoked: boolean; target: Target; owner: string; locale: "zh" | "en"; close: () => void; position: number; total: number; completed: number; next: () => void; onDeleted: (id: string) => void }) {
  const zh = locale === "zh", key = deletionReceiptKey(owner, target);
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), returnFocus = useRef(""), confirmedHere = useRef(""), resumeSent = useRef(""), startInFlight = useRef<Promise<unknown> | null>(null), resumeInFlight = useRef<Promise<unknown> | null>(null), latch = useRef(false), alive = useRef(true), delivered = useRef(false), onDeletedRef = useRef(onDeleted);
  const revoked = useRef(accessRevoked), requestVersion = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null), [job, setJob] = useState<Job | null>(null), [saved, setSaved] = useState<Saved | null>(null);
  // Optional shared links ticked for clean-up; unticked ones are kept as history on the original file.
  const [unlink, setUnlink] = useState<string[]>([]), [sharedFilter, setSharedFilter] = useState<"all" | "link" | "kept">("all");
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(""), [blocked, setBlocked] = useState(accessRevoked);
  const [blockers, setBlockers] = useState<Blocker[]>([]), [confirming, setConfirming] = useState(""), [notice, setNotice] = useState("");
  const [renderedReviewKey, setRenderedReviewKey] = useState(accessReviewKey);
  if (renderedReviewKey !== accessReviewKey) {
    setRenderedReviewKey(accessReviewKey); setPreview(null); setJob(null); setName(""); setLoading(!finished); setBlockers([]); setNotice(""); setConfirming("");
  }
  const [renderedRevocation, setRenderedRevocation] = useState(accessRevoked);
  if (renderedRevocation !== accessRevoked) {
    setRenderedRevocation(accessRevoked);
    if (accessRevoked) { setPreview(null); setJob(null); setName(""); setBlocked(true); }
  }
  useLayoutEffect(() => { onDeletedRef.current = onDeleted; }, [onDeleted]);
  useLayoutEffect(() => { revoked.current = accessRevoked; }, [accessRevoked]);
  // Invalidate older responses before the next paint when platform visibility/ownership changes.
  useLayoutEffect(() => { requestVersion.current++; }, [accessReviewKey]);
  const releaseDeletionRisk = useDraftRisk(busy || Boolean(saved && job?.state !== "complete"));
  useLayoutEffect(() => {
    const node = dialog.current, opener = document.activeElement;
    node?.showModal();
    // Layout cleanup runs while the dialog is still attached, so focus can return to the control that opened it.
    return () => { node?.close(); if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) opener.focus(); };
  }, []);
  // Replaced controls (inline confirmation, finished requests) must not drop focus to the page body.
  useEffect(() => {
    const node = dialog.current;
    if (busy || !node?.open) return;
    const back = returnFocus.current; returnFocus.current = "";
    const target = back ? [...node.querySelectorAll<HTMLElement>("[data-cancel-upload]")].find(item => item.dataset.cancelUpload === back) : undefined;
    if (target) target.focus();
    // The inline confirmation starts on its safe choice.
    else if (confirming) node.querySelector<HTMLElement>("[data-keep-upload]")?.focus();
    else if (!node.contains(document.activeElement) || document.activeElement === node) heading.current?.focus();
  }, [busy, confirming, loading, blockers, job?.state]);
  const store = useCallback((value: Saved | null) => {
    let persisted = true;
    if (key) try { if (value) window.localStorage.setItem(key, JSON.stringify(value)); else window.localStorage.removeItem(key); } catch {
      persisted = false;
      // The current dialog retains this identity even when browser storage is unavailable.
    }
    setSaved(value);
    if (persisted) notifyBusinessDeletionReceiptsChanged();
    return persisted;
  }, [key]);
  const finish = useCallback((value: Job) => {
    if (revoked.current) return;
    setJob(value);
    if (value.state === "complete") {
      setBusy(false); setLoading(false);
      releaseDeletionRisk();
      store(null);
      if (!delivered.current) { delivered.current = true; onDeletedRef.current(value.target.id); }
    }
  }, [store, releaseDeletionRisk]);
  const errorText = useCallback((reason: unknown, submitted = true) => {
    if (reason instanceof DeletionResponseError) {
      if (reason.blockers.length && reason.code !== "PROJECT_HISTORY_PROTECTED") return zh ? "删除被下列事项阻止。逐项处理后请重新核对。" : "Deletion is blocked by the items below. Resolve each one, then review again.";
      const subitem = target.kind === "video" || target.kind === "language";
      if (subitem && subitemMessages[reason.code]) return subitemMessages[reason.code][zh ? 0 : 1];
      if (messages[reason.code]) return messages[reason.code][zh ? 0 : 1];
      if (reason.status === 403 || reason.status === 404) return zh ? "记录不存在或访问权限已变化。原操作记录已保留，请核对权限后再继续。" : "Record unavailable or access changed. The original operation receipt is retained. Review access before continuing.";
    }
    if (!submitted) return zh ? "删除影响范围加载失败，尚未提交删除。请关闭后重新核对；若仍失败，请联系管理员检查服务端错误。" : "The deletion impact could not be loaded. No deletion was submitted. Close and review again; if this persists, ask an administrator to check the server error.";
    return zh ? "删除结果待核对，请勿重新发起删除。" : "Deletion is unconfirmed. Do not start another deletion.";
  }, [zh, target.kind]);
  const loadPreview = useCallback(async (version = requestVersion.current) => {
    const result = await request(`/api/business-deletion?kind=${target.kind}&id=${encodeURIComponent(target.id)}`);
    if (!isPreview(result, { id: target.id, kind: target.kind })) throw new DeletionResponseError(200, "UNCONFIRMED");
    if (alive.current && !revoked.current && version === requestVersion.current) { setPreview(result); setJob(null); setName(""); setBlocked(false); setBlockers([]); }
  }, [target.id, target.kind]);
  const receiveJob = useCallback(async (result: unknown, attempt: Saved, version = requestVersion.current) => {
    if (!isJob(result, attempt)) throw new DeletionResponseError(200, "UNCONFIRMED");
    if (!alive.current || revoked.current || version !== requestVersion.current) return;
    setBlocked(false);
    if (result.state === "rejected") {
      // The server confirms no cleanup occurred and has released preparation locks.
      store(null); setPreview(null); setJob(null); setName("");
      await loadPreview(version);
      if (alive.current && version === requestVersion.current) setError(zh ? "上次删除未执行，请重新核对影响范围。" : "The previous deletion did not execute. Review the impact again.");
    } else finish(result);
  }, [finish, loadPreview, store, zh]);
  const hideRevoked = useCallback((reason: unknown) => {
    if (reason instanceof DeletionResponseError && (reason.status === 403 || reason.status === 404)) {
      setPreview(null); setJob(null); setName("");
      // A status lookup cannot distinguish an uncreated receipt from inaccessible work.
      // Only the same start identity may be checked again; known account revocation blocks it.
      setBlocked(reason.code === "DELETION_AUTHORITY_CHANGED" || reason.status === 403 && reason.code !== "DELETION_ACCESS_DENIED");
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const version = ++requestVersion.current;
    const current = () => alive.current && version === requestVersion.current;
    const load = async () => {
      let existing: Saved | null = null;
      try {
        try { const candidate: unknown = key ? JSON.parse(window.localStorage.getItem(key) || "null") : null; if (isSaved(candidate, { id: target.id, kind: target.kind })) existing = candidate; } catch { /* Invalid receipts never authorize deletion. */ }
        if (existing) {
          store(existing);
          const lookup = () => request(`/api/business-deletion?job=${encodeURIComponent(existing!.submissionId)}`);
          const ownStart = confirmedHere.current === existing.submissionId ? startInFlight.current : null;
          let result: unknown;
          try { result = await lookup(); }
          catch (reason) {
            // Only "not found" is ambiguous while this dialog's own start is still being recorded; any other answer stands.
            if (!ownStart || !(reason instanceof DeletionResponseError && reason.code === "DELETION_ACCESS_DENIED")) throw reason;
            result = null;
          }
          if (ownStart && (result === null || record(result)?.state === "preparing")) {
            await ownStart.catch(() => undefined);
            if (!current()) return;
            result = await lookup();
          }
          // D2: the started target disappears from the platform list, which rechecks access here. When the server
          // still returns this job unstarted, the confirmation given in this dialog continues once; the server
          // rechecks authority again. A remounted recovery entry never writes without a new click.
          // Real storage can keep this dialog's own resume running for seconds; a recheck in that window sees
          // "running". Wait for that same request and read the job again instead of reporting it unfinished.
          const ownResume = confirmedHere.current === existing.submissionId ? resumeInFlight.current : null;
          if (ownResume && record(result)?.state === "running") {
            await ownResume.catch(() => undefined);
            if (!current()) return;
            result = await lookup();
          }
          if (current() && isJob(result, existing) && result.state === "pending" && confirmedHere.current === existing.submissionId && resumeSent.current !== existing.submissionId) {
            resumeSent.current = existing.submissionId;
            try { result = await request("/api/business-deletion", { operation: "resume", jobId: existing.submissionId }); }
            catch (reason) { if (current()) { hideRevoked(reason); setError(errorText(reason)); } result = await request(`/api/business-deletion?job=${encodeURIComponent(existing.submissionId)}`); }
          }
          if (current()) { await receiveJob(result, existing, version); if (isJob(result, existing) && ["pending", "failed", "running"].includes(result.state) && current()) setError(unfinishedJobText(result, zh)); }
        }
        else await loadPreview(version);
      } catch (reason) { if (current()) { hideRevoked(reason); setBlockers(listedBlockers(reason)); setError(errorText(reason, Boolean(existing))); } }
      finally { if (current()) setLoading(false); }
    };
    // A verified completion survives platform removal; no private impact or new lookup is needed.
    if (!finished) void load();
    return () => { alive.current = false; requestVersion.current = version + 1; };
  }, [key, target.id, target.kind, store, receiveJob, loadPreview, hideRevoked, errorText, accessReviewKey, finished, zh]);
  const run = async () => {
    if (latch.current || loading || blocked || accessRevoked) return;
    if (!saved && (!preview || !deletionAvailable(preview) || name !== preview.name)) return;
    const version = requestVersion.current;
    const current = () => alive.current && !revoked.current && version === requestVersion.current;
    latch.current = true; setBusy(true); setError(""); setNotice("");
    const priorReceipt = saved;
    const attempt = priorReceipt || { ...target, submissionId: browserRandomUUID(), revision: preview!.revision, previewHash: preview!.previewHash, confirmationName: name,
      ...(target.kind === "video" || target.kind === "language" ? { unlinkShared: [...unlink].sort() } : {}) };
    confirmedHere.current = attempt.submissionId;
    if (!store(attempt)) {
      setError(zh ? "无法保存操作凭据，请恢复浏览器存储后再继续。" : "The operation receipt could not be saved. Restore browser storage before continuing.");
      latch.current = false; setBusy(false); return;
    }
    let accepted = false;
    try {
      // start is idempotent for this exact identity and payload, including after a lost response.
      const starting = request("/api/business-deletion", { operation: "start", ...attempt });
      startInFlight.current = starting;
      let result = await starting.finally(() => { if (startInFlight.current === starting) startInFlight.current = null; });
      if (!isJob(result, attempt)) throw new DeletionResponseError(200, "UNCONFIRMED");
      if (!current()) return;
      accepted = true;
      if (result.state === "pending" || result.state === "failed") {
        finish(result);
        resumeSent.current = attempt.submissionId;
        const resuming = request("/api/business-deletion", { operation: "resume", jobId: attempt.submissionId });
        resumeInFlight.current = resuming;
        result = await resuming.finally(() => { if (resumeInFlight.current === resuming) resumeInFlight.current = null; });
      }
      if (current()) {
        await receiveJob(result, attempt, version);
        if (isJob(result, attempt) && !["complete", "rejected"].includes(result.state)) setError(unfinishedJobText(result, zh));
      }
    } catch (reason) {
      if (current()) {
        hideRevoked(reason); setBlockers(listedBlockers(reason)); setError(errorText(reason));
        if ((accepted || priorReceipt) && !(reason instanceof DeletionResponseError && (reason.status === 403 || reason.status === 404))) {
          // The cleanup request failed after the job was recorded: read the job instead of guessing.
          try {
            const status = await request(`/api/business-deletion?job=${encodeURIComponent(attempt.submissionId)}`);
            if (current() && isJob(status, attempt)) { await receiveJob(status, attempt, version); if (current() && !["complete", "rejected"].includes(status.state)) setError(unfinishedJobText(status, zh)); }
          } catch { /* The unconfirmed-result warning above stays; the receipt is kept for the next check. */ }
        }
        if (!priorReceipt && !accepted && reason instanceof DeletionResponseError && confirmedStartRejections.has(reason.code)) {
          // These explicit server rejections precede cleanup. Require a fresh review and name.
          store(null); setPreview(null); setName(""); setJob(null);
          try {
            await loadPreview(version);
            // The blockers listed with the rejection are gone; do not keep pointing at an empty list.
            if (current() && listedBlockers(reason).length) setError(messages.STALE_DELETION_PREVIEW[zh ? 0 : 1]);
          } catch (reviewError) { if (current()) { hideRevoked(reviewError); setBlockers(listedBlockers(reviewError)); setError(errorText(reviewError, false)); } }
        }
      }
    } finally { latch.current = false; if (alive.current) setBusy(false); }
  };
  // Cancels exactly the reviewed upload; the server rechecks ownership, scope and idle time.
  const cancelUpload = async (blocker: Blocker) => {
    if (latch.current || loading || accessRevoked) return;
    const version = requestVersion.current, current = () => alive.current && !revoked.current && version === requestVersion.current;
    latch.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request("/api/business-deletion", { operation: "cancel-upload", projectId: target.id, uploadId: blocker.id, reviewedUpdatedAt: blocker.updatedAt });
      if (current()) setNotice(zh ? "已取消该上传。后台清理完成（通常约一分钟）后，请重新核对删除。" : "Upload cancelled. Review deletion again after background cleanup finishes (usually about a minute).");
    } catch (reason) { if (current()) { hideRevoked(reason); setError(reason instanceof DeletionResponseError && messages[reason.code] ? messages[reason.code][zh ? 0 : 1] : zh ? "取消结果未确认，请重新核对后再操作。" : "Cancellation is unconfirmed. Review again before acting."); } }
    try { if (current()) { setConfirming(""); await loadPreview(version); } }
    catch (reason) { if (current()) { hideRevoked(reason); setBlockers(listedBlockers(reason)); setError(shown => shown || errorText(reason, false)); } }
    finally { latch.current = false; if (alive.current) setBusy(false); }
  };
  const reviewAgain = async () => {
    if (latch.current || accessRevoked) return;
    const version = requestVersion.current, current = () => alive.current && !revoked.current && version === requestVersion.current;
    latch.current = true; setBusy(true); setError(""); setNotice(""); setConfirming("");
    try { await loadPreview(version); }
    catch (reason) { if (current()) { hideRevoked(reason); setBlockers(listedBlockers(reason)); setError(errorText(reason, false)); } }
    finally { latch.current = false; if (alive.current) setBusy(false); }
  };
  const when = (value?: string) => { const parsed = value ? new Date(value) : null; return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString(zh ? "zh-CN" : "en-US", { dateStyle: "short", timeStyle: "short" }) : ""; };
  const actionText = (blocker: Blocker) => {
    switch (blocker.action) {
      case "cancel_upload": return zh ? "可取消上传；取消后无法续传，需等待清理。" : "Cancel to stop this upload. It cannot be resumed; cleanup must finish first.";
      case "ask_uploader": return zh ? `请上传者完成或取消。${blocker.availableAt ? `闲置满 60 分钟后（${when(blocker.availableAt)} 起）你也可以取消。` : ""}` : `Ask the uploader to finish or cancel it.${blocker.availableAt ? ` After 60 idle minutes (from ${when(blocker.availableAt)}) you can also cancel it.` : ""}`;
      case "wait_for_upload": return zh ? "正在处理中，请等待完成后重新核对。" : "Still being processed. Review again once it finishes.";
      case "wait_for_cleanup": return zh ? "等待后台清理，完成后重新核对。" : "Waiting for cleanup. Review again once it finishes.";
      case "ask_administrator": return zh ? "需管理员核对恢复，请提供下方记录编号。" : "Administrator review is needed. Provide the record ID below.";
      case "wait_for_analysis": return zh ? "分析或翻译仍在进行，请等待完成。" : "Analysis or translation is still running. Wait for it to finish.";
      case "archive_instead": return zh ? "已成功交付，正式历史受保护。请改用归档。" : "Delivered successfully; its history is protected. Archive the project instead.";
      case "already_archived": return zh ? "已归档，正式历史受保护，不能永久删除。" : "Archived; its history is protected and cannot be permanently deleted.";
      case "resolve_relationship": return zh ? "与其他客户、项目或素材库共享，请先解除关联。" : "Shared with another customer, project or the asset library. Remove the relationship first.";
      case "wait_for_project_deletion": return zh ? "项目删除未完成，请负责人从“核对删除任务”继续清理。" : "Project deletion is unfinished. Its owner can continue from “Review deletion”.";
      default: return "";
    }
  };
  const attemptClose = () => { if (!busy && mayLeaveDrafts(locale)) close(); };
  const summary = accessRevoked || finished ? undefined : job?.summary || preview?.summary;
  const disclosure = accessRevoked || finished || job || saved || !isDisclosure(preview?.disclosure) ? undefined : preview?.disclosure;
  // Section labels and the kept note follow the target: a video or language deletion never reads as a project deletion.
  const scopeLabel = target.kind === "video" ? (zh ? "此视频" : "this video") : target.kind === "language" ? (zh ? "此语言版本" : "this language version") : (zh ? "项目" : "the project");
  const keepNote = target.kind === "video" ? (zh ? "只删除此视频及其语言版本的独占内容。所属项目和其他视频保留，不受影响。" : "Only this video and its language versions' exclusive content is deleted. The project and its other videos are kept.")
    : target.kind === "language" ? (zh ? "只删除此语言版本的独占内容。所属视频、项目和其他语言版本保留，不受影响。" : "Only this language version's exclusive content is deleted. Its video, the project and the other language versions are kept.") : "";
  const more = (list: Listed<unknown>) => list.total > list.items.length ? <li>{zh ? `另有 ${list.total - list.items.length} 项未列出` : `${list.total - list.items.length} more not listed`}</li> : null;
  return <dialog ref={dialog} className="account-access-dialog business-delete-dialog" aria-labelledby="permanent-delete-title" onCancel={event => { event.preventDefault(); attemptClose(); }}><DialogSections>
    <header><h2 id="permanent-delete-title" ref={heading} tabIndex={-1}>{zh ? "永久删除" : "Permanently delete"}{total > 1 ? ` · ${position + 1}/${total}` : ""}</h2><button className="secondary-button" disabled={busy} onClick={attemptClose}>{zh ? "关闭" : "Close"}</button></header>
    <div className="account-access-dialog-body">
      {accessRevoked ? <p role="alert">{zh ? "访问权限已变化，原操作凭据已保留，请核对权限后再继续。" : "Access changed. The original operation receipt is retained. Review access before continuing."}</p> : loading && !finished ? <p role="status">{zh ? "正在核对影响范围…" : "Reviewing impact…"}</p> : <>
        <strong>{finished ? "" : preview?.name || (job ? saved?.confirmationName : "") || ""}</strong>
        {summary && <><p className="danger-text">{zh ? "确认后将永久清理以下关联记录与独占文件，无法恢复。共享素材及仍被其他对象引用的文件保留。" : "This permanently removes the linked records and exclusive files below. It cannot be undone. Shared material and files referenced elsewhere are retained."}</p>{keepNote && <p className="delete-keep-note" role="note"><strong>{keepNote}</strong></p>}<dl className="delete-impact-grid">{([["projects", "项目", "Projects"], ["tasks", "语言任务", "Language tasks"], ["reports", "正式日报", "Daily reports"], ["quality", "质检记录", "Quality records"], ["deliveries", "交付记录", "Deliveries"], ["files", "文件记录", "Files"], ["retainedObjects", "保留的共享存储对象", "Shared objects retained"]] as const).map(([field, cn, en]) => <div key={field}><dt>{zh ? cn : en}</dt><dd>{summary[field]}</dd></div>)}{disclosure && <div><dt>{zh ? "暂存文件（将被永久丢弃）" : "Temporary files (permanently discarded)"}</dt><dd>{disclosure.temporaryFiles.total}</dd></div>}</dl></>}
        {disclosure && <div className="delete-disclosure">
          <details><summary>{zh ? `正式文件与版本（${disclosure.files.total}）· 随${scopeLabel}删除` : `Official files and versions (${disclosure.files.total}) · deleted with ${scopeLabel}`}</summary><ul>{disclosure.files.items.map(file => <li key={file.id}><span>{file.name || file.id} · v{file.version}</span><small>{[file.uploader, when(file.createdAt), ...file.references.map(reference => referenceText(reference, zh))].filter(Boolean).join(" · ")}</small></li>)}{more(disclosure.files)}</ul></details>
          <details open={disclosure.temporaryFiles.total > 0}><summary>{zh ? `暂存文件（${disclosure.temporaryFiles.total}）· 将被永久丢弃` : `Temporary files (${disclosure.temporaryFiles.total}) · will be permanently discarded`}</summary><ul>{disclosure.temporaryFiles.items.map(file => <li key={file.id}><span>{file.name || file.id}</span><small>{[file.uploader, zh ? `上传于 ${when(file.createdAt)}` : `uploaded ${when(file.createdAt)}`, zh ? `原定 ${when(file.expiresAt)} 到期` : `expires ${when(file.expiresAt)}`].join(" · ")}</small></li>)}{more(disclosure.temporaryFiles)}</ul></details>
          <details><summary>{zh ? `待清理（${disclosure.pendingCleanups.total}）· 随${scopeLabel}一并清除` : `Pending cleanups (${disclosure.pendingCleanups.total}) · removed with ${scopeLabel}`}</summary><ul>{disclosure.pendingCleanups.items.map(item => <li key={item.id}><span>{item.name || item.id}</span><small>{[item.uploader, blockerStates[item.state]?.[zh ? 0 : 1] ?? item.state, when(item.updatedAt)].filter(Boolean).join(" · ")}</small></li>)}{more(disclosure.pendingCleanups)}</ul></details>
          <details><summary>{zh ? `保留的共享存储对象（${disclosure.retained.total}）· 不删除` : `Shared storage objects retained (${disclosure.retained.total}) · not deleted`}</summary><ul>{disclosure.retained.items.map((item, index) => <li key={index}><span>{item.name || (zh ? "未命名对象" : "Unnamed object")}</span></li>)}{more(disclosure.retained)}</ul></details>
        </div>}
        {disclosure?.shared && disclosure.shared.total > 0 && !finished && <details open className="delete-disclosure delete-shared" data-section="shared">
          <summary>{zh ? `共享内容（${disclosure.shared.total}）· 原件不删除` : `Shared content (${disclosure.shared.total}) · originals are not deleted`}</summary>
          <label>{zh ? "筛选" : "Filter"}<select value={sharedFilter} disabled={busy || Boolean(saved)} onChange={event => setSharedFilter(event.target.value as "all" | "link" | "kept")}>
            <option value="all">{zh ? "全部" : "All"}</option><option value="link">{zh ? "可选：本对象对其他原件的关联" : "Optional: links to originals owned elsewhere"}</option><option value="kept">{zh ? "必要：移交给其他语言的文件" : "Required: files handed over to another language"}</option>
          </select></label>
          <ul>{disclosure.shared.items.filter(item => sharedFilter === "all" || item.kind === sharedFilter).map(item => <li key={item.id} data-shared={item.kind}>
            {item.optional ? <label><input type="checkbox" disabled={busy || Boolean(saved)} checked={unlink.includes(item.id)} onChange={event => setUnlink(event.target.checked ? [...unlink, item.id] : unlink.filter(id => id !== item.id))} />{item.name}{item.ownerName ? ` · ${item.ownerName}` : ""}</label> : <span>{item.name}</span>}
            <small>{item.optional ? (unlink.includes(item.id) ? (zh ? "清理本对象的这条关联；原件及其他引用保留" : "Clean up this link; the original and other references stay") : (zh ? "不清理：作为原件的历史记录保留，可追溯" : "Not cleaned: kept as a traceable history entry on the original")) : (zh ? `仍被${item.ownerName}使用：保留原件并移交给${item.ownerName}（必要，不可选）` : `Still used by ${item.ownerName}: the original is kept and handed over to ${item.ownerName} (required)`)}</small>
          </li>)}{more(disclosure.shared)}</ul>
        </details>}
        {finished ? <p role="status">{zh ? "永久清理已完成。" : "Permanent cleanup completed."}</p> : saved ? <p role="status">{zh ? `清理进度：${job?.completedObjects ?? 0} / ${job?.totalObjects ?? "—"}` : `Cleanup: ${job?.completedObjects ?? 0} / ${job?.totalObjects ?? "—"}`}</p> : preview && !deletionAvailable(preview) ? <p role="status">{zh ? "永久删除暂未开放。" : "Permanent deletion is not available yet."}</p> : preview ? <label>{zh ? "输入名称确认" : "Enter the name to confirm"}<input autoComplete="off" value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder={preview.name} /></label> : null}
      </>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {blockers.length > 0 && !accessRevoked && <section className="delete-blockers" aria-label={zh ? "阻止删除的事项" : "Items blocking deletion"}>
        <h3>{zh ? `阻止删除的事项（${blockers.length}）` : `Blocking deletion (${blockers.length})`}</h3>
        <ul>{blockers.map((blocker, index) => <li key={`${blocker.type}:${blocker.id}:${index}`}>
          <strong>{blockerTypes[blocker.type]?.[zh ? 0 : 1] ?? blocker.type}{blocker.object ? ` · ${blocker.object}` : ""}</strong>
          <small>{[blocker.owner,blockerStates[blocker.state]?.[zh ? 0 : 1] ?? blocker.state].filter(Boolean).join(" · ")}</small>
          <p>{actionText(blocker)}</p>
          {blocker.type==='upload'&&blocker.owner===owner&&<a className="secondary-button" href={`/?view=uploads&upload=${encodeURIComponent(blocker.id)}`} aria-disabled={busy} onClick={event=>{event.preventDefault();if(!busy&&mayLeaveDrafts(locale)){close();window.dispatchEvent(new CustomEvent('lifewood-manage-upload',{detail:{id:blocker.id}}));}}}>{zh?'前往我的上传':'Open my uploads'}</a>}
          <details><summary>{zh?'时间与记录编号':'Times and record ID'}</summary><small>{blocker.id}</small><small>{[blocker.startedAt&&(zh?`开始 ${when(blocker.startedAt)}`:`Started ${when(blocker.startedAt)}`),blocker.updatedAt&&(zh?`最后活动 ${when(blocker.updatedAt)}`:`Last activity ${when(blocker.updatedAt)}`)].filter(Boolean).join(' · ')}</small></details>
          {blocker.action === "cancel_upload" && target.kind === "project" && (confirming === blocker.id ? <div className="delete-blocker-confirm" role="group" aria-label={zh ? "确认取消上传" : "Confirm upload cancellation"}><span>{zh ? "确认取消此未完成上传？上传者会收到通知，已上传的分片不能恢复。" : "Cancel this unfinished upload? The uploader is notified and uploaded parts cannot be recovered."}</span><button className="secondary-button danger" disabled={busy} onClick={() => void cancelUpload(blocker)}>{zh ? "确认取消上传" : "Confirm cancel upload"}</button><button className="secondary-button" data-keep-upload disabled={busy} onClick={() => { returnFocus.current = blocker.id; setConfirming(""); }}>{zh ? "保留" : "Keep it"}</button></div> : <button className="secondary-button" data-cancel-upload={blocker.id} disabled={busy || loading} onClick={() => { setConfirming(blocker.id); setNotice(""); }}>{zh ? "取消此上传" : "Cancel this upload"}</button>)}
        </li>)}</ul>
        <button className="secondary-button" disabled={busy || loading} onClick={() => void reviewAgain()}>{zh ? "重新核对" : "Review again"}</button>
      </section>}
    </div>
    <footer><button className="secondary-button" disabled={busy} onClick={attemptClose}>{zh ? "关闭" : "Close"}</button>{finished ? position + 1 < total && <button className="secondary-button" disabled={accessRevoked} onClick={next}>{zh ? "核对下一个" : "Review next"}</button> : <button className="secondary-button danger" disabled={busy || loading || blocked || accessRevoked || (!saved && (!preview || !deletionAvailable(preview) || name !== preview.name))} onClick={() => void run()}>{busy ? (zh ? "正在处理…" : "Working…") : saved ? (zh ? "核对并继续清理" : "Check and continue") : (zh ? "确认永久删除" : "Permanently delete")}</button>}<span>{total > 1 ? (zh ? `已完成 ${completed} 个` : `${completed} completed`) : ""}</span></footer>
  </DialogSections></dialog>;
}
