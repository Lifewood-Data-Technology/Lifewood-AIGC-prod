"use client";
import {FileVideo, FileAudio, FileDocument, FileImage} from "./DirectFileMedia";
import DeseretProductionPanel from "./DeseretProductionPanel";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type FormEvent } from "react";
import UploadDropzone from "./UploadDropzone";
import {directTransferEnabled} from "../lib/direct-upload-client";
import {uploadSizeError,uploadSizeLabel} from "../lib/upload-policy";
import {useUploadLimit} from "./useUploadLimit";
import UploadQueue from "./UploadQueue";
import {uploadWithFeedback} from "../lib/upload-activity";
import {ProjectProductionFlow} from "./ProductionFlow";
import SelectControl from "./SelectControl";
import DataList, { DataListTable } from "./DataList";
import RowMenu from "./RowMenu";
import PermanentBusinessDeleteDialog from "./PermanentBusinessDeleteDialog";
import PendingBusinessDeletionButton from "./PendingBusinessDeletionButton";
import ProjectDeadlineSync from "./ProjectDeadlineSync";
import { projectDeadlineSnapshot, type ProjectDeadlineSnapshot } from "../lib/project-date-sync";
import { SearchIcon } from "./ControlIcons";
import { languageLabel, languageLabels } from "../lib/business-locale";
import { groupDailyReports, reportDay } from "../lib/daily-reports";
import { useDraftRisk } from "./useLocalDraft";
import { workspaceFetch } from "../lib/tab-session";
import { makeTextWorkbook } from "../lib/text-workbook";
import type { DeseretWorkspace } from "../lib/deseret-workspace";
import { publisherReviewStatus, projectStatusLabel, projectStatusTone } from "../lib/project-status";

type Row = Record<string, unknown>;
type Locale = "zh" | "en";
type Platform = {
  account: { email: string; name: string; access: string }; permissions: Record<string, boolean>;
  projects: Row[]; clients: Row[]; videos: Row[]; languages: Row[]; team: Row[];
  checkpoints: Row[]; checkpointFiles: Row[]; assignmentHistory: Row[]; handovers: Row[];
  fileRecords: Row[]; fileVersions: Row[]; folders: Row[]; audit: Row[]; workflowStatuses: string[];
  projectFinalSubmissions?: Row[];
  customerFeedback?: Row[];
};
type Mutation = (action: string, payload: Record<string, string>) => Promise<Row | null>;

function pendingCustomerRevision(data: Platform, task: Row): Row | undefined {
  const project = data.projects.find(row => row.id === task.project_id);
  if (data.account.access !== "project" || !data.permissions["projects.manage"] ||
      project?.project_owner_email !== data.account.email || task.status !== "待最终确认") return;
  return data.customerFeedback?.find(row => row.language_project_id === task.id &&
    row.project_id === task.project_id && row.status === "Pending PM review");
}

function CustomerRevisionReview({ feedback, task, locale, mutate }: { feedback: Row; task: Row; locale: Locale; mutate: Mutation }) {
  const active = useActiveMaintenanceDialog();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState("");
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const resolve = async (outcome: "request_details" | "assign_revision") => {
    if (!active.current || lock.current || result || (outcome === "assign_revision" && !task.editor_email)) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const saved = await mutate("project.customer_feedback.resolve", { feedbackId: str(feedback.id), outcome });
      if (!active.current) return;
      if (saved) setResult(outcome === "assign_revision" ? t("客户修改任务已下发剪辑师。", "Customer revision assigned to the editor.") : t("已退回销售补充客户意见。", "Returned to sales for more detail."));
      else setError(t("未能完成审核，请刷新核对后重试。", "Review was not completed. Refresh to check and retry."));
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : t("审核失败，请刷新核对。", "Review failed. Refresh to check."));
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  };
  return <section className="pm-detail-card" aria-label={t("客户修改意见待确认", "Customer revision needs confirmation")}>
    <h3>{t("客户修改意见待确认", "Customer revision needs confirmation")}</h3>
    <p>{str(feedback.summary)}</p>
    <small>{str(feedback.owner_name)} · {str(feedback.created_at)}</small>
    {result ? <p role="status">{result}</p> : <>
      <p>{t("确认后下发剪辑师修改；意见不清楚时退回销售补充。", "Confirm to send revisions to the editor, or return to sales for clarification.")}</p>
      <div className="pm-actions">
        <button disabled={busy} onClick={() => void resolve("request_details")}>{t("退回销售补充", "Request more detail")}</button>
        <button className="pm-primary" disabled={busy || !task.editor_email} onClick={() => void resolve("assign_revision")}>{t("确认并下发修改", "Confirm and assign revision")}</button>
      </div>
      {!task.editor_email && <small>{t("请先分配剪辑师，再下发修改。", "Assign an editor before sending revisions.")}</small>}
    </>}
    {error && <InlineError message={error}/>}
  </section>;
}
type Config = { type: "project" | "video" | "language"; project?: Row; video?: Row; task?: Row };
const str = (value: unknown) => String(value ?? "");
const dueDate = (value: unknown) => {
  const date = str(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
};
const closed = (task: Row) => ["已交付", "已归档", "已终止"].includes(str(task.status));
const finished = (task: Row) => ["已交付", "已归档"].includes(str(task.status));
const visibleStatus = projectStatusLabel;
const projectStatus = (project: Row) => visibleStatus(project.workflow_status || project.status);
const publisherStatus = (project: Row) => {
  if (project.source_system !== "deseret_book" || closed(project) || project.status === "已暂停") return "";
  const status = projectStatus(project);
  const review = publisherReviewStatus(project.source_system, status, project.deseret_stage);
  if (review) return review;
  if (project.deseret_intake === "pending") return "待受理";
  if (project.deseret_intake === "needsSupplement") return "待出版社补充";
  return "";
};
const stageNames: Record<string, [string, string]> = {
  intake: ["项目受理", "Intake"], production: ["分镜制作", "Scene production"],
  storyboard_review: ["出版社审阅分镜", "Publisher scene review"], revision: ["待分派返修", "Awaiting revision assignment"],
  final_production: ["成片制作", "Final production"], final_review: ["出版社终审", "Publisher final review"],
  delivery: ["交付", "Delivery"], archived: ["已归档", "Archived"],
};
const languageCodes = languageLabels.map(([code]) => code as string);
type ProjectTab = "tasks" | "publisher";
function projectDetailUrl(projectId: string) {
  if (!projectId || typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  return url.pathname.replace(/\/$/, "") === `/projects/${encodeURIComponent(projectId)}` ? url : null;
}
function subscribeProjectTab(update: () => void) {
  window.addEventListener("popstate", update);
  window.addEventListener("pm-project-tab", update);
  return () => {
    window.removeEventListener("popstate", update);
    window.removeEventListener("pm-project-tab", update);
  };
}

const statusEnglish: Record<string, string> = { "待出版社审核":"Awaiting publisher review", "待分派返修":"Awaiting revision assignment", "返修中":"Revision in progress", "待受理":"Awaiting intake", "待出版社补充":"Awaiting publisher materials", "待分配":"Unassigned", "制作中":"In production", "待质检":"In review", "质检驳回":"Changes requested", "客户要求修改":"Customer revisions", "待客户预览":"Customer preview", "待最终确认":"Customer confirmation", "已交付":"Delivered", "已归档":"Archived", "已暂停":"Paused", "已终止":"Terminated" };
function Status({ value, locale }: { value: string; locale: Locale }) {
  const status = visibleStatus(value);
  const tone = projectStatusTone(status) || "neutral";
  return <span className={`pm-status pm-status-${tone}`}>{locale === "zh" ? status : statusEnglish[status] || status}</span>;
}
function Progress({ value, locale }: { value: unknown; locale: Locale }) {
  const available = value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return <span className="pm-progress"><b>{available ? `${percent}%` : locale === "zh" ? "未填报" : "Not reported"}</b><span><i style={{ width: `${percent}%` }} /></span></span>;
}
function InlineError({ message }: { message: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: "nearest" }); }, [message]);
  return <p ref={ref} className="pm-danger" role="alert">{message}</p>;
}
function useActiveMaintenanceDialog() {
  const active = useRef(true);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return active;
}
export function ProjectModal({ title, children, footer, onClose, wide = false, busy = false, className = "" }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { const node = ref.current, trigger = document.activeElement; node?.showModal(); return () => { node?.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); }; }, []);
  return <dialog ref={ref} className={`pm-modal pm-workspace${wide ? " pm-modal-wide" : ""} ${className}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="pm-modal-head"><h2 id={id}>{title}</h2><button type="button" className="pm-close" aria-label="Close / 关闭" disabled={busy} onClick={onClose}>×</button></header>
    <div className="pm-modal-body">{children}</div>
    <footer className="pm-modal-foot">{footer}</footer>
  </dialog>;
}
function FileList({ files, locale, renderFile }: { files: Row[]; locale: Locale; renderFile: (file: Row) => ReactNode }) {
  return <div className="pm-files">{files.length ? files.map((file, index) => <div key={str(file.current_version_id || file.file_version_id || file.id) + index}><span>{str(file.display_name || file.original_name)}</span>{renderFile(file)}</div>) : <p className="pm-muted">{locale === "zh" ? "暂无附件" : "No files"}</p>}</div>;
}

export function ProjectFileActions({ file, locale }: { file: Row; locale: Locale }) {
  const [preview,setPreview]=useState(false),[text,setText]=useState(""),[error,setError]=useState("");
  const zh=locale==="zh",name=str(file.display_name||file.original_name),mime=str(file.mime_type),id=str(file.current_version_id||file.file_version_id),url=`/api/files?id=${encodeURIComponent(id)}`;
  const kind=mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":mime==="application/pdf"?"pdf":/\.(txt|srt|md|csv|json|vtt)$/i.test(name)?"text":"other";
  useEffect(()=>{
    if(!preview||kind!=="text")return;
    const controller=new AbortController();
    void (async()=>{try{const response=await workspaceFetch(url,{signal:controller.signal});if(!response.ok)throw Error("unavailable");const reader=response.body?.getReader();if(!reader)throw Error("unavailable");const chunks:Uint8Array[]=[];let bytes=0;while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1024*1024){await reader.cancel();throw Error("large");}chunks.push(value);}const merged=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.length;}setText(new TextDecoder().decode(merged));}catch(error){if(!controller.signal.aborted)setError(error instanceof Error&&error.message==="large"?(zh?"文本较大，请下载查看。":"Text is too large to preview. Download it instead."):(zh?"文件不可用或已删除，请刷新核对。":"File unavailable or deleted. Refresh to check."));}})();
    return ()=>controller.abort();
  },[preview,kind,url,zh]);
  if(!id)return <small>{zh?"文件不可用":"Unavailable"}</small>;
  return <div className="pm-file-actions"><button className="pm-link" onClick={()=>{setError("");setText("");setPreview(true);}}>{zh?"查看":"View"}</button><a href={`${url}&download=1`}>{zh?"下载":"Download"}</a>{preview&&<ProjectModal title={name} onClose={()=>setPreview(false)} footer={<><a href={`${url}&download=1`}>{zh?"下载原文件":"Download original"}</a><button onClick={()=>setPreview(false)}>{zh?"关闭预览":"Close preview"}</button></>}>{error?<p role="alert" className="pm-danger">{error}</p>:kind==="text"?<pre className="pm-text-preview">{text|| (zh?"加载中…":"Loading…")}</pre>:kind==="image"?

      <FileImage className="pm-media-preview" alt={name} src={url} onError={()=>setError(zh?"预览失败，请下载查看。":"Preview failed. Download the file.")}/>:kind==="video"?<FileVideo className="pm-media-preview" src={url} controls preload="metadata"><track kind="captions"/></FileVideo>:kind==="audio"?<FileAudio className="pm-media-preview" src={url} controls><track kind="captions"/></FileAudio>:kind==="pdf"?<FileDocument className="pm-document-preview" title={name} src={url} sandbox="allow-same-origin"/>:<p className="pm-empty">{zh?"此格式请下载后使用相应软件查看。":"Download this format and open it with the appropriate application."}</p>}</ProjectModal>}</div>;
}

export default function ProjectManagementWorkspace({ platform: data, locale, selectedProjectId = "", selectedLanguageId = "", initialClientId = "", search = "", onOpen, onBack, onProjectDeleted, mutate, toast, renderFile, projectWorkflow }: {
  platform: Platform; locale: Locale; projectWorkflow?: ReactNode; selectedProjectId?: string; selectedLanguageId?: string; initialClientId?: string; search?: string;
  onOpen: (id: string) => void; onBack: () => void; onProjectDeleted?: () => void; mutate: Mutation; toast: (message: string) => void; renderFile: (file: Row) => ReactNode;
}) {
  const zh = locale === "zh", t = (a: string, b: string) => zh ? a : b;
  const [query, setQuery] = useState(search), [owner, setOwner] = useState(""), [client, setClient] = useState(initialClientId), [status, setStatus] = useState("");
  const [priority, setPriority] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState(""), [sort, setSort] = useState("due"), [signal, setSignal] = useState("all"), [page, setPage] = useState(1);
  const [projectsSelected, setProjectsSelected] = useState<string[]>([]), [tasksSelected, setTasksSelected] = useState<string[]>([]);
  const [config, setConfig] = useState<Config | null>(null), [taskId, setTaskId] = useState(selectedLanguageId), [tab, setTab] = useState("overview"), [assignment, setAssignment] = useState<string[] | null>(null);
  const [teamOpen, setTeamOpen] = useState(false), [member, setMember] = useState(""), [lifecycle, setLifecycle] = useState<Row | null>(null), [feedback, setFeedback] = useState("");
  const [deleteProjectId, setDeleteProjectId] = useState("");
  // One video or one language version; its project stays.
  const [deleteSubitem, setDeleteSubitem] = useState<{ kind: "video" | "language"; id: string } | null>(null);
  // Saved video/language receipts can be checked even after their rows vanished; completion only refreshes data.
  const subitemRecovery = <>
    <PendingBusinessDeletionButton kind="video" locale={locale} label={t("核对上次视频删除","Review previous video deletion")} onDeleted={()=>onProjectDeleted?.()}/>
    <PendingBusinessDeletionButton kind="language" locale={locale} label={t("核对上次语言版本删除","Review previous language deletion")} onDeleted={()=>onProjectDeleted?.()}/>
  </>;
  const [archivePending, setArchivePending] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const archiveLock = useRef(false);
  const archiveActive = useActiveMaintenanceDialog();
  useEffect(()=>{if(!feedback)return;const timer=window.setTimeout(()=>setFeedback(""),3200);return()=>window.clearTimeout(timer);},[feedback]);
  const routeKey=JSON.stringify([selectedProjectId,selectedLanguageId,data.account.email,data.account.access]);
  const [renderedRoute,setRenderedRoute]=useState(routeKey);
  if(renderedRoute!==routeKey){setRenderedRoute(routeKey);setTaskId(selectedLanguageId);setTasksSelected([]);setConfig(null);setAssignment(null);setLifecycle(null);setTeamOpen(false);}
  const visibleSelectedProjects = projectsSelected.filter(id => data.projects.some(project => str(project.id) === id));
  if (visibleSelectedProjects.length !== projectsSelected.length) setProjectsSelected(visibleSelectedProjects);
  const project = data.projects.find(row => row.id === selectedProjectId);
  const [embeddedTab, setEmbeddedTab] = useState<{route: string; tab: ProjectTab} | null>(null);
  const urlTab = useSyncExternalStore(subscribeProjectTab, () => projectDetailUrl(selectedProjectId)?.searchParams.get("projectTab") ?? null, () => null);
  const detailTab = urlTab === "publisher" || urlTab === "tasks" ? urlTab : embeddedTab?.route === routeKey ? embeddedTab.tab : null;
  function setDetailTab(tab: ProjectTab) {
    const url = projectDetailUrl(selectedProjectId);
    if (!url) {
      setEmbeddedTab({route: routeKey, tab});
      return;
    }
    if (url.searchParams.get("projectTab") === tab) return;
    url.searchParams.set("projectTab", tab);
    window.history.pushState(window.history.state, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new window.Event("pm-project-tab"));
  }
  const [confirmedIntake, setConfirmedIntake] = useState<DeseretWorkspace["intake"] | null>(null);
  const [intakeContext, setIntakeContext] = useState("");
  const context = JSON.stringify([routeKey, project?.deseret_intake]);
  if (context !== intakeContext) {
    setIntakeContext(context);
    setConfirmedIntake(null);
  }
  const isDeseret = project?.source_system === "deseret_book";
  const intake = confirmedIntake ?? project?.deseret_intake;
  const assignmentReady = !isDeseret || intake === "accepted";
  const activeDetailTab = detailTab ?? (isDeseret && !assignmentReady ? "publisher" : "tasks");
  const showTasks = !isDeseret || activeDetailTab === "tasks";
  const canManage = data.permissions["projects.manage"] === true;
  const availableTask = (id: string) => data.languages.find(row => str(row.id) === id && data.projects.some(parent => parent.id === row.project_id));
  const configAvailable = canManage && (!config?.project || data.projects.some(row => row.id === config.project?.id)) && (!config?.video || data.videos.some(row => row.id === config.video?.id && row.project_id === config.project?.id)) && (!config?.task || Boolean(availableTask(str(config.task.id))));
  const canAssignTask = (target: Row | undefined) => {
    const owner = target && data.projects.find(row => row.id === target.project_id);
    if (!target || !owner || closed(target)) return false;
    return owner.id === project?.id ? assignmentReady : owner.source_system !== "deseret_book" || owner.deseret_intake === "accepted";
  };
  const assignmentAvailable = canManage && Boolean(assignment?.length) && (assignment ?? []).every(id => canAssignTask(availableTask(id)));
  const lifecycleAvailable = canManage && Boolean(lifecycle && availableTask(str(lifecycle.id)));
  // Drop revoked targets, including the stored form state, so restoring access cannot reopen them.
  if (config && !configAvailable) setConfig(null);
  if (assignment && !assignmentAvailable) setAssignment(null);
  if (lifecycle && !lifecycleAvailable) setLifecycle(null);
  const canDeleteProject = (target: Row) => canManage && data.account.access === "project" && Boolean(data.account.email.trim()) && str(target.project_owner_email).trim().toLowerCase() === data.account.email.trim().toLowerCase();
  const deletingVisibleProject = data.projects.find(target => target.id === deleteProjectId);
  const deletionAccessReviewKey = JSON.stringify([data.account.email, data.account.access, canManage, deletingVisibleProject?.project_owner_email ?? null, deletingVisibleProject?.revision ?? null]);
  const deletionAccessRevoked = !canManage || data.account.access !== "project" || Boolean(deletingVisibleProject && !canDeleteProject(deletingVisibleProject));
  const handleProjectDeleted = (ids: string[]) => { setDeleteProjectId(""); setProjectsSelected(current => current.filter(id => !ids.includes(id))); if (ids.includes(selectedProjectId)) onBack(); onProjectDeleted?.(); toast(t("项目已永久删除，关联记录与独占文件已清理。", "Project permanently deleted. Its linked records and exclusive files were removed.")); };
  const tasksOf = (p: Row) => data.languages.filter(task => task.project_id === p.id);
  const videosOf = (p: Row) => data.videos.filter(video => video.project_id === p.id);
  const archiveAction = (target: Row) => {
    if (target.source_system !== "deseret_book" || !canManage || data.account.access !== "project" || !data.account.email.trim() || str(target.project_owner_email).trim().toLowerCase() !== data.account.email.trim().toLowerCase()) return;
    const tasks = tasksOf(target);
    if (!tasks.length || !tasks.every(closed)) return;
    const archived = target.status === "已归档" || tasks.some(task => task.status === "已归档");
    if (archived && !tasks.every(task => ["已归档", "已终止"].includes(str(task.status)))) return;
    return archived ? "project.unarchive" : "project.archive";
  };
  const changeArchive = async (target: Row) => {
    const action = archiveAction(target);
    if (!action || archiveLock.current) return;
    const restoring = action === "project.unarchive";
    const message = restoring
      ? t(`确认取消“${str(target.name)}”的归档？已终止任务仍保持终止。`, `Unarchive “${str(target.name)}”? Terminated tasks stay terminated.`)
      : t(`确认归档“${str(target.name)}”？历史记录与文件会保留，可以取消归档。`, `Archive “${str(target.name)}”? History and files are retained. The archive can be reversed.`);
    if (!window.confirm(message)) return;
    archiveLock.current = true;
    setArchivePending(str(target.id));
    setArchiveError("");
    try {
      const result = await mutate(action, { projectId: str(target.id) });
      if (!archiveActive.current) return;
      if (result) toast(restoring ? t("项目已取消归档。", "Project unarchived.") : t("项目已归档。", "Project archived."));
      else setArchiveError(t("未能更新归档状态，请刷新核对后重试。", "The archive status was not updated. Refresh to check and retry."));
    } catch (error) {
      if (archiveActive.current) setArchiveError(error instanceof Error ? error.message : t("归档操作失败，请刷新核对。", "The archive action failed. Refresh to check."));
    } finally {
      archiveLock.current = false;
      if (archiveActive.current) setArchivePending("");
    }
  };
  const projectMore = (target: Row) => {
    const action = archiveAction(target);
    if (!action && !canDeleteProject(target)) return null;
    return <RowMenu label={t("更多", "More")}>
      {action && <button disabled={Boolean(archivePending)} onClick={() => void changeArchive(target)}>{action === "project.unarchive" ? t("取消归档", "Unarchive") : t("归档（可恢复）", "Archive (reversible)")}</button>}
      {canDeleteProject(target) && <button disabled={Boolean(archivePending)} className="danger-text" onClick={() => setDeleteProjectId(str(target.id))}>{t("永久删除项目…", "Permanently delete project…")}</button>}
    </RowMenu>;
  };
  const today = reportDay();
  const overdue = (p: Row) => Boolean(dueDate(p.due_date)) && !["已交付","已归档","已终止"].includes(projectStatus(p)) && dueDate(p.due_date) < today;
  const weekEnd = new Date(Date.parse(today) + (7 - (new Date(today).getUTCDay() || 7)) * 86400000).toISOString().slice(0,10);
  const matchesSignal = (p: Row, value: string) => value === "all" || (value === "overdue" ? overdue(p) : value === "qc" ? tasksOf(p).some(task => task.status === "待质检") : value === "week" ? !closed({status:projectStatus(p)}) && dueDate(p.due_date) >= today && dueDate(p.due_date) <= weekEnd : tasksOf(p).some(task => ["制作中","质检驳回","客户要求修改"].includes(str(task.status))));
  const filtered = data.projects.filter(p => (!query || `${str(p.name)} ${str(p.client_name)} ${videosOf(p).map(v => v.name).join(" ")}`.toLowerCase().includes(query.toLowerCase())) && (!client || p.client_id === client) && (!owner || p.sales_email === owner) && (!status || (publisherStatus(p) || projectStatus(p)) === status) && (!priority || p.priority === priority) && (!from || dueDate(p.due_date) >= from) && (!to || Boolean(dueDate(p.due_date)) && dueDate(p.due_date) <= to) && matchesSignal(p, signal)).sort((a,b) => {
    if(sort === "name")return str(a.name).localeCompare(str(b.name));
    const left=dueDate(a.due_date),right=dueDate(b.due_date);
    if(!left||!right)return left?-1:right?1:0;
    return (sort === "due-desc" ? -1 : 1) * left.localeCompare(right);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / 8)), currentPage = Math.min(page,pages), visible = filtered.slice((currentPage - 1) * 8,currentPage * 8);
  const task = data.languages.find(row => row.id === taskId);
  const person = (email: unknown) => str(data.team.find(row => row.email === email)?.name || email) || t("未分配","Unassigned");
  const salesName = (project: Row) => str(project.sales_name || data.team.find(row => row.email === project.sales_email)?.name) || t("姓名未设置", "Name unavailable");
  const lang = (task: Row) => languageLabel(task.language_code,task.language,locale);
  const activeTasks = (email: string) => data.languages.filter(task => !closed(task) && task.status !== "已暂停" && (task.editor_email === email || task.reviewer_email === email));
  const reset = () => { setQuery("");setOwner("");setClient("");setStatus("");setPriority("");setFrom("");setTo("");setSignal("all");setSort("due");setPage(1);setProjectsSelected([]); };
  const changed = (setter: (value:string)=>void) => (event: {target:{value:string}}) => { setter(event.target.value);setPage(1);setProjectsSelected([]); };
  const openTask = (id: string, nextTab = "overview") => {setTaskId(id);setTab(nextTab);};
  const exportRows = (selected?: string[]) => {
    const scope = project ? [project] : selected ? data.projects.filter(p => selected.includes(str(p.id))) : filtered;
    const publisherDetail = isDeseret;
    const rows = [[
      t("项目","Project"), t("视频","Video"), t("语言","Language"), t("制作进度","Progress"),
      ...(publisherDetail ? [t("出版社流程","Publisher workflow")] : []),
      t("状态","Status"), t("剪辑师","Editor"), t("质检员","Reviewer"), t("截止日期","Deadline"),
    ], ...scope.flatMap(p => tasksOf(p).map(task => {
      const stage = stageNames[str(p.deseret_stage)];
      const status = publisherStatus(task) || visibleStatus(task.status);
      return [str(p.name), str(task.video_name), lang(task),
        task.production_progress == null || task.production_progress === "" ? t("未填报","Not reported") : `${task.production_progress}%`,
        ...(publisherDetail ? [stage ? t(...stage) : "—"] : []),
        t(status, statusEnglish[status] || status), person(task.editor_email), person(task.reviewer_email), dueDate(task.due_date)];
    }))];
    const csvCell = (value: string) => `"${(/^\s*[=+@-]|^[\t\r\n]/.test(value) ? "'" : "") + value.replaceAll('"','""')}"`;
    const content = publisherDetail
      ? new Blob([new Uint8Array(makeTextWorkbook(rows, t("制作进度", "Progress"), [48,42,20,16,26,22,20,20,18]))], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
      : new Blob(["\uFEFF" + rows.map(row=>row.map(csvCell).join(",")).join("\r\n")], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(content), link = document.createElement("a");
    link.href = url;
    link.download = publisherDetail ? "project-language-progress.xlsx" : "project-language-progress.csv";
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),20000);
  };
  return <div className="pm-workspace" data-workflow={isDeseret ? "deseret" : undefined}>
    {project && <nav className="pm-breadcrumb" aria-label={t("面包屑导航","Breadcrumb")}><button className="pm-link" onClick={onBack}>{t("项目管理","Project management")}</button><span> / </span><span>{str(project.client_name)}</span><span> / </span><span>{str(project.name)}</span></nav>}
    <div className="page-heading"><div><span className="eyebrow">Lifewood AIGC</span><h1>{project ? str(project.name) : t("项目管理","Project management")}</h1></div>{project&&<div className="pm-actions">{isDeseret && <button onClick={()=>exportRows()}>{t("导出进度明细","Export progress")}</button>}<button onClick={()=>{setTeamOpen(true);setMember("");}}>{t("人员负载","Team workload")}</button>{canManage && (project ? <><button onClick={()=>setConfig({type:"project",project})}>{t("编辑项目","Edit project")}</button><button className="pm-primary" disabled={closed({status:projectStatus(project)})} onClick={()=>setConfig({type:"video",project})}>{t("添加视频","Add video")}</button>{projectMore(project)}</> : null)}</div>}</div>
    {archiveError && <InlineError message={archiveError}/>}
    {selectedProjectId && !project && <section className="pm-unavailable" role="status"><b>{t("项目不存在、已删除或你无权访问。","This project does not exist, was deleted, or you do not have access.")}</b><button className="pm-link" onClick={onBack}>{t("返回项目列表","Back to projects")}</button></section>}
    {!project ? <DataList className="pm-project-list" ariaLabel={t("项目列表","Project list")}
      toolbar={<><label className="pm-search"><SearchIcon/><input aria-label={t("搜索项目","Search projects")} placeholder={t("搜索项目、客户或视频名称…","Search project, customer or video…")} value={query} onChange={changed(setQuery)}/></label><div className="data-list-query-actions"><button className="pm-link query-reset-button" onClick={reset}>{t("重置筛选","Reset filters")}</button></div></>}
      actions={<><button onClick={()=>{setTeamOpen(true);setMember("");}}>{t("人员负载","Team workload")}</button>{canManage&&<button className="pm-primary" onClick={()=>setConfig({type:"project"})}>{t("新增项目","Create project")}</button>}</>}
      filters={<div className="pm-list-filters">
        <label className="data-list-field"><span>{t("项目范围","Project scope")}</span><SelectControl locale={locale} aria-label={t("项目范围","Project scope")} value={signal} onChange={changed(setSignal)}>{[["all",t("全部项目","All projects")],["overdue",t("项目逾期","Overdue")],["qc",t("待质检","In review")],["week",t("本周到期","Due this week")],["making",t("制作中","In production")]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</SelectControl></label>
        <label className="data-list-field"><span>{t("销售负责人","Sales owner")}</span><SelectControl locale={locale} aria-label={t("销售负责人筛选","Sales owner")} value={owner} onChange={changed(setOwner)}><option value="">{t("全部","All")}</option>{[...new Map(data.projects.map(p=>[str(p.sales_email),salesName(p)])).entries()].filter(([id])=>id).map(([id,name])=><option key={id} value={id}>{name}</option>)}</SelectControl></label>
        <label className="data-list-field"><span>{t("客户","Customer")}</span><SelectControl locale={locale} aria-label={t("客户筛选","Customer")} value={client} onChange={changed(setClient)}><option value="">{t("全部","All")}</option>{data.clients.map(c=><option key={str(c.id)} value={str(c.id)}>{str(c.name)}</option>)}</SelectControl></label>
        <label className="data-list-field"><span>{t("项目状态","Project status")}</span><SelectControl locale={locale} aria-label={t("项目状态筛选","Project status")} value={status} onChange={changed(setStatus)}><option value="">{t("全部","All")}</option>{[...new Set([...data.workflowStatuses.filter(s=>!["待补充资料","待交付"].includes(s)), ...data.projects.map(publisherStatus).filter(Boolean)])].map(s=><option key={s} value={s}>{t(s,statusEnglish[s]||s)}</option>)}</SelectControl></label>
        <label className="data-list-field"><span>{t("紧急程度","Priority")}</span><SelectControl locale={locale} aria-label={t("紧急程度筛选","Priority")} value={priority} onChange={changed(setPriority)}><option value="">{t("全部","All")}</option><option value="standard">{t("普通","Normal")}</option><option value="high">{t("高","High")}</option><option value="urgent">{t("紧急","Urgent")}</option></SelectControl></label>
        <label className="data-list-field pm-date"><span>{t("截止起始","Due from")}</span><input aria-label={t("截止起始","Due from")} type="date" value={from} onChange={changed(setFrom)}/></label>
        <label className="data-list-field pm-date"><span>{t("截止结束","Due to")}</span><input aria-label={t("截止结束","Due to")} type="date" min={from} value={to} onChange={changed(setTo)}/></label>
        <label className="data-list-field"><span>{t("排序","Sort")}</span><SelectControl locale={locale} aria-label={t("排序","Sort")} value={sort} onChange={changed(setSort)}><option value="due">{t("截止日期升序","Deadline ascending")}</option><option value="due-desc">{t("截止日期降序","Deadline descending")}</option><option value="name">{t("项目名称","Project name")}</option></SelectControl></label>
      </div>}
      summary={<><span>{t("项目列表","Project list")} <strong>{filtered.length} / {data.projects.length}</strong></span><span aria-live="polite">{t(`已选 ${projectsSelected.length} 项`,`${projectsSelected.length} selected`)}</span></>}
      resultActions={<><button onClick={()=>exportRows()}>{t("导出 CSV","Export CSV")}</button><button disabled={!projectsSelected.length} onClick={()=>exportRows(projectsSelected)}>{t("导出所选","Export selected")}</button><button disabled={!projectsSelected.length} onClick={()=>setProjectsSelected([])}>{t("取消选择","Clear selection")}</button>{canManage&&data.account.access==="project"&&<><PendingBusinessDeletionButton kind="project" locale={locale} onDeleted={handleProjectDeleted}/>{subitemRecovery}</>}</>}
      pagination={<div className="pm-pagination"><button disabled={currentPage===1} onClick={()=>{setPage(currentPage-1);setProjectsSelected([]);}}>{t("上一页","Previous")}</button><span>{currentPage} / {pages}</span><button disabled={currentPage===pages} onClick={()=>{setPage(currentPage+1);setProjectsSelected([]);}}>{t("下一页","Next")}</button></div>}>
      <div className="pm-table-scroll"><table className="pm-project-table"><thead><tr><th><input type="checkbox" aria-label={t("选择当前页全部项目","Select this page")} checked={visible.length>0&&visible.every(p=>projectsSelected.includes(str(p.id)))} onChange={e=>setProjectsSelected(e.target.checked?[...new Set([...projectsSelected,...visible.map(p=>str(p.id))])]:projectsSelected.filter(id=>!visible.some(p=>p.id===id)))}/></th>{[t("项目","Project"),t("客户","Customer"),t("视频 / 语言","Videos / languages"),t("完成情况","Completion"),t("紧急程度","Priority"),t("业务状态","Status"),t("截止日期","Deadline"),t("操作","Actions")].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{visible.map(p=>{const tasks=tasksOf(p),done=tasks.filter(finished).length;return <tr key={str(p.id)} className={overdue(p)?"pm-overdue-row":""}><td><input type="checkbox" aria-label={`${t("选择项目","Select project")} ${p.name}`} checked={projectsSelected.includes(str(p.id))} onChange={e=>setProjectsSelected(e.target.checked?[...projectsSelected,str(p.id)]:projectsSelected.filter(id=>id!==p.id))}/></td><td><button className="pm-link pm-project-name" title={str(p.name)} onClick={()=>onOpen(str(p.id))}>{str(p.name)}</button><small>{t("销售：","Sales: ")}{salesName(p)}</small></td><td><span className="pm-customer-name" title={str(p.client_name)}>{str(p.client_name)}</span><small>{str(p.region)}</small></td><td>{videosOf(p).length} {t("个视频","videos")}<small>{tasks.length} {t("个语言版本","language versions")}</small></td><td><b>{done} / {tasks.length}</b><span className="pm-completion"><i style={{width:`${tasks.length?done/tasks.length*100:0}%`}}/></span><small>{t("已完成语言版本","Completed languages")}</small></td><td>{p.priority==="urgent"?t("紧急","Urgent"):p.priority==="high"?t("高","High"):t("普通","Normal")}</td><td><Status value={publisherStatus(p) || projectStatus(p)} locale={locale}/><small>{["待受理", "待出版社补充", "待分派返修"].includes(publisherStatus(p)) ? person(p.project_owner_email) : p.source_system === "deseret_book" && p.deseret_intake === "accepted" && projectStatus(p) === "待分配" ? t("已受理，待分派人员","Accepted, awaiting assignment") : tasks.some(task=>task.status==="待质检")?t(`${tasks.filter(task=>task.status==="待质检").length} 个待质检`,"Awaiting review"):tasks.some(task=>!task.editor_email&&!closed(task))?t("待分配人员","Assignment required"):t("进度正常","On track")}</small></td><td className={overdue(p)?"pm-danger":""}>{dueDate(p.due_date)||"—"}<small>{overdue(p)?t("项目已逾期","Overdue"):t("项目截止","Project deadline")}</small></td><td><div className="pm-row-actions"><button className="pm-link" onClick={()=>onOpen(str(p.id))}>{t("查看","View")}</button>{canManage&&<><button className="pm-link" disabled={closed({status:projectStatus(p)})} onClick={()=>setConfig({type:"video",project:p})}>{t("添加视频","Add video")}</button><button className="pm-link" onClick={()=>setConfig({type:"project",project:p})}>{t("编辑","Edit")}</button></>}{projectMore(p)}</div></td></tr>;})}</tbody></table>{!filtered.length&&<div className="pm-empty">{t("没有符合条件的项目，请调整筛选或重置条件。","No matching projects. Adjust or reset the filters.")}</div>}</div>
    </DataList> : <>
      {!projectWorkflow && <div className="pm-overview-strip">{[[t("视频 / 语言版本","Videos / languages"),`${videosOf(project).length} / ${tasksOf(project).length}`],[t("已完成语言版本","Completed languages"),tasksOf(project).filter(finished).length],[t("未分配剪辑师","Unassigned editors"),tasksOf(project).filter(task=>!task.editor_email&&!closed(task)).length],[t("项目截止日期","Project deadline"),dueDate(project.due_date)||"—"]].map(([label,value])=><div key={str(label)}><small>{label}</small><b>{value}</b></div>)}</div>}
      {isDeseret && <>
        <div className="pm-tabs" role="group" aria-label={t("项目详情","Project details")}>
          <button type="button" aria-pressed={activeDetailTab === "publisher"} onClick={()=>setDetailTab("publisher")}>{t("出版社资料与审核","Publisher brief & review")}</button>
          <button type="button" aria-pressed={showTasks} onClick={()=>setDetailTab("tasks")}>{t("任务分派","Task assignments")}</button>
        </div>
        {activeDetailTab === "publisher" && <DeseretProductionPanel key={`${data.account.email}:${str(project.id)}`} projectId={str(project.id)} locale={locale} onIntakeChange={setConfirmedIntake}/>}
        {showTasks && !assignmentReady && <p className="pm-info">{t("接受出版社资料后可分配人员。","Accept the publisher brief before assigning people.")}</p>}
      </>}
      {!projectWorkflow && !isDeseret && <div className="pm-requirement"><b>{t("项目要求","Project requirements")}</b><span>{str(project.specification)}</span><button onClick={()=>exportRows()}>{t("导出进度明细","Export progress")}</button></div>}
      {!projectWorkflow && showTasks && <div className="pm-video-toolbar"><h2>{t("视频与语言版本","Videos & languages")}</h2><div className="pm-bulk-actions">{canDeleteProject(project)&&subitemRecovery}<span aria-live="polite">{t(`已选 ${tasksSelected.length} 个语言版本`,`${tasksSelected.length} languages selected`)}</span><button className="pm-primary" disabled={!canManage||!assignmentReady||!tasksSelected.length} onClick={()=>setAssignment(tasksSelected)}>{t("批量分配 / 调度","Batch assignment")}</button><button disabled={!tasksSelected.length} onClick={()=>setTasksSelected([])}>{t("取消选择","Clear selection")}</button></div></div>}
      {showTasks && (projectWorkflow ?? <section className="pm-videos">{videosOf(project).map(video=><section className="pm-video" key={str(video.id)}><header><div><b>{str(video.name)}</b><small>{str(video.aspect_ratio)} · {video.duration_seconds?`${str(video.duration_seconds)}s`:t("时长未设置","Duration not set")} · {data.languages.filter(task=>task.video_id===video.id).length} {t("个语言版本","languages")}</small></div><div className="pm-actions">{canManage&&<><button onClick={()=>setConfig({type:"video",project,video})}>{t("编辑视频","Edit video")}</button><button disabled={closed({status:projectStatus(project)})} onClick={()=>setConfig({type:"language",project,video})}>{t("添加语言版本","Add languages")}</button></>}{canDeleteProject(project)&&<button className="danger-text" onClick={()=>setDeleteSubitem({kind:"video",id:str(video.id)})}>{t("永久删除视频…","Permanently delete video…")}</button>}</div></header><DataListTable ariaLabel={t("语言版本","Languages")} className="pm-table-scroll"><table className="pm-task-table"><thead><tr>{[t("选择","Select"),t("语言版本","Language"),t("视频制作进度","Production progress"),t("业务状态","Status"),t("剪辑师","Editor"),t("质检员","Reviewer"),t("截止日期","Deadline"),t("操作","Actions")].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{data.languages.filter(task=>task.video_id===video.id).map(task=><tr key={str(task.id)}><td><input type="checkbox" aria-label={`${str(video.name)} ${lang(task)}`} disabled={closed(task)||!canManage||!assignmentReady} checked={tasksSelected.includes(str(task.id))} onChange={e=>setTasksSelected(e.target.checked?[...tasksSelected,str(task.id)]:tasksSelected.filter(id=>id!==task.id))}/></td><td><button className="pm-link" onClick={()=>openTask(str(task.id))}>{lang(task)}</button></td><td><Progress value={task.production_progress} locale={locale}/><small>{task.production_progress_at?str(task.production_progress_at).slice(0,10):t("尚未填报日报","No daily report")}</small></td><td><Status value={publisherStatus(task) || str(task.status)} locale={locale}/></td><td>{person(task.editor_email)}</td><td>{person(task.reviewer_email)}</td><td className={!closed(task)&&dueDate(task.due_date)&&dueDate(task.due_date)<today?"pm-danger":""}>{dueDate(task.due_date)||"—"}</td><td><div className="pm-row-actions"><button className="pm-link" onClick={()=>openTask(str(task.id))}>{pendingCustomerRevision(data,task)?t("审核客户修改","Review customer revisions"):t("跟踪进度","Track progress")}</button>{canManage&&<button className="pm-link" disabled={closed(task)||!assignmentReady} onClick={()=>setAssignment([str(task.id)])}>{task.editor_email?t("人员调度","Reassign"):t("分配人员","Assign")}</button>}<button className="pm-link" onClick={()=>openTask(str(task.id),"history")}>{t("记录","History")}</button>{canDeleteProject(project)&&<button className="pm-link danger-text" onClick={()=>setDeleteSubitem({kind:"language",id:str(task.id)})}>{t("永久删除…","Permanently delete…")}</button>}</div></td></tr>)}</tbody></table></DataListTable></section>)}{!videosOf(project).length&&<div className="pm-empty">{t("还没有视频，点击“添加视频”配置语言版本。","No videos yet. Add a video to configure language versions.")}</div>}</section>)}
    </>}
    {task&&<ProjectTaskDetails key={`${data.account.email}:${str(task.id)}`} mutate={mutate} task={task} data={data} locale={locale} tab={tab} setTab={setTab} renderFile={renderFile} onClose={()=>setTaskId("")} onEdit={()=>{setTaskId("");setConfig({type:"language",task,project:data.projects.find(p=>p.id===task.project_id),video:data.videos.find(v=>v.id===task.video_id)});}} onAssign={()=>{setTaskId("");setAssignment([str(task.id)]);}} onLifecycle={()=>{setTaskId("");setLifecycle(task);}} canManage={canManage} assignmentReady={canAssignTask(task)} currentProject={task.project_id===selectedProjectId} onOpenPublisher={()=>{setTaskId("");if(task.project_id===selectedProjectId)setDetailTab("publisher");else onOpen(str(task.project_id));}}/>}
    {config&&configAvailable&&<ProjectConfig key={`${config.type}:${str(config.project?.id)}:${str(config.video?.id)}:${str(config.task?.id)}`} config={config} data={data} locale={locale} mutate={mutate} onClose={()=>setConfig(null)} onDone={()=>{setConfig(null);setFeedback(t("配置已保存","Configuration saved"));}}/>}
    {assignment&&assignmentAvailable&&<ProjectAssignment key={assignment.join(":")} ids={assignment} data={data} locale={locale} mutate={mutate} onClose={()=>setAssignment(null)} onDone={()=>{setAssignment(null);setTasksSelected([]);setFeedback(t("人员安排已保存","Assignment saved"));}}/>}
    {lifecycle&&lifecycleAvailable&&<ProjectLifecycle key={str(lifecycle.id)} task={lifecycle} locale={locale} mutate={mutate} onClose={()=>setLifecycle(null)}/>}
    {deleteSubitem&&<PermanentBusinessDeleteDialog targets={[deleteSubitem]} locale={locale} accessReviewKey={deletionAccessReviewKey} accessRevoked={deletionAccessRevoked} close={()=>setDeleteSubitem(null)} onDeleted={()=>{setDeleteSubitem(null);setTasksSelected([]);onProjectDeleted?.();toast(deleteSubitem.kind==="video"?t("视频已永久删除，其独占内容已清理，项目保留。","Video permanently deleted. Its exclusive content was removed; the project remains."):t("语言版本已永久删除，其独占内容已清理，视频与项目保留。","Language version permanently deleted. Its exclusive content was removed; the video and project remain."));}}/>}
    {deleteProjectId&&<PermanentBusinessDeleteDialog targets={[{kind:"project",id:deleteProjectId}]} locale={locale} accessReviewKey={deletionAccessReviewKey} accessRevoked={deletionAccessRevoked} close={()=>setDeleteProjectId("")} onDeleted={handleProjectDeleted}/>}
    {teamOpen&&<ProjectModal wide title={member?`${person(member)} · ${t("在办任务","Active tasks")}`:t("人员负载","Team workload")} onClose={()=>{if(member)setMember("");else setTeamOpen(false);}} footer={<button onClick={()=>{if(member)setMember("");else setTeamOpen(false);}}>{member?t("返回人员列表","Back to team"):t("关闭","Close")}</button>}>{member?<>{activeTasks(member).map(task=><div className="pm-record" key={str(task.id)}><b>{str(task.project_name)} / {str(task.video_name)} · {lang(task)}</b><p><Status value={publisherStatus(task) || str(task.status)} locale={locale}/> · {str(task.due_date)}</p><button onClick={()=>{setTeamOpen(false);openTask(str(task.id));}}>{t("查看语言版本","View language task")}</button></div>)}{!activeTasks(member).length&&<p className="pm-empty">{t("暂无在办任务","No active tasks")}</p>}</>:<><p className="pm-muted">{t("统计可查看项目中未完成、未终止且未暂停的语言版本。","Active language tasks in accessible projects, excluding paused and closed tasks.")}</p><div className="pm-table-scroll"><table><thead><tr><th>{t("成员","Member")}</th><th>{t("角色","Role")}</th><th>{t("在办任务","Active tasks")}</th><th>{t("查看","View")}</th></tr></thead><tbody>{data.team.filter(person=>["production","quality"].includes(str(person.access_group))).map(person=><tr key={str(person.email)}><td>{str(person.name)}</td><td>{person.access_group==="production"?t("剪辑师","Editor"):t("质检员","Reviewer")}</td><td>{activeTasks(str(person.email)).length}</td><td><button className="pm-link" onClick={()=>setMember(str(person.email))}>{t("查看任务","View tasks")}</button></td></tr>)}</tbody></table></div></>}</ProjectModal>}
    {feedback&&<div className="pm-feedback" role="status"><span aria-hidden="true">✓</span><b>{feedback}</b><button aria-label={t("关闭提示","Dismiss message")} onClick={()=>setFeedback("")}>×</button></div>}
  </div>;
}

function ProjectConfig({ config, data, locale, mutate, onClose, onDone }: { config: Config; data: Platform; locale: Locale; mutate: Mutation; onClose: () => void; onDone: () => void }) {
  const active = useActiveMaintenanceDialog();
  const {type,project,video,task}=config, original=type==="project"?project:type==="video"?video:task;
  const zh=locale==="zh", t=(a:string,b:string)=>zh?a:b, formId=useId();
  const [name,setName]=useState(str(original?.name)),[client,setClient]=useState(str(project?.client_id)),[due,setDue]=useState(str(task?.due_date||project?.due_date)),[requirements,setRequirements]=useState(str(task?.requirements||project?.specification)),[priority,setPriority]=useState(str(project?.priority||"standard"));
  const [duration,setDuration]=useState(video?str(video.duration_seconds):"60"),[ratio,setRatio]=useState(str(video?.aspect_ratio||"16:9")),[languages,setLanguages]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[dirty,setDirty]=useState(false);
  const [dateReview,setDateReview]=useState<ProjectDeadlineSnapshot|null>(null);
  const dateInventory=type==="project"&&project?projectDeadlineSnapshot(str(project.id),data.languages,data.videos):null;
  const dateChanged=type==="project"&&!!project&&due!==str(project.due_date);
  const syncStale=Boolean(dateChanged&&dateReview&&dateReview.token!==dateInventory?.token);
  useDraftRisk(dirty||busy);
  const close=()=>{if(!busy&&(!dirty||window.confirm(t("尚未保存，确定放弃本次修改？","Discard unsaved changes?"))))onClose();};
  const submit=async(event:FormEvent)=>{event.preventDefault();if(!active.current||busy)return;setError("");if(syncStale){setError(t("任务或视频已变化，请重新核对日期同步范围。","Tasks or videos changed. Review the deadline scope again."));return;}if(type!=="project"&&!original&&!languages.length){setError(t("请至少选择一个语言版本","Select at least one language"));return;}setBusy(true);try {
    let result:Row|null=null;
    if(type==="project")result=await mutate(project?"project.update":"project.create",{projectId:str(project?.id),expectedRevision:str(project?.revision),clientId:client,name,dueDate:due,requirements,priority,planningOnly:"true",...(project?{dueDateSync:dateChanged&&dateReview?"unfinished":"project",...(dateChanged&&dateReview?{dueDateReview:dateReview.token}:{})}:{})});
    else if(type==="video")result=await mutate(video?"project.video.update":"project.video.add",{projectId:str(project?.id),videoId:str(video?.id),expectedRevision:str(video?.revision),name,durationSeconds:duration,aspectRatio:ratio,videos:JSON.stringify([{name,durationSeconds:Number(duration),aspectRatio:ratio,languages,dueDate:due,brief:requirements,priority}])});
    else if(task)result=await mutate("project.language.update",{languageProjectId:str(task.id),expectedRevision:str(task.revision),dueDate:due,requirements});
    else { const remaining=[...languages]; for(const languageCode of languages){if(!active.current)return;result=await mutate("project.language.add",{projectId:str(project?.id),videoId:str(video?.id),languageCode,dueDate:due,requirements});if(!active.current)return;if(!result){setLanguages(remaining);break;}remaining.splice(remaining.indexOf(languageCode),1);setLanguages([...remaining]);} }
    if(!active.current)return;
    if(result)onDone();else setError(t("未能完成保存，请核对提示。填写内容已保留。","Save was not completed. Review the message; your input is retained."));
  }catch(error){setError(error instanceof Error?error.message:t("保存失败，填写内容已保留。","Save failed. Your input is retained."));}finally{setBusy(false);}};
  return <ProjectModal title={`${original?t("编辑","Edit "):t("新建","New ")}${type==="project"?t("项目","project"):type==="video"?t("视频","video"):t("语言版本","language version")}`} onClose={close} busy={busy} footer={<><button disabled={busy} onClick={close}>{t("取消","Cancel")}</button><button className="pm-primary" form={formId} type="submit" disabled={busy||syncStale}>{busy?t("保存中…","Saving…"):t("保存","Save")}</button></>}><form id={formId} onSubmit={submit} onChangeCapture={()=>setDirty(true)}><fieldset disabled={busy} className="pm-form-fields">{type==="video"&&<div className="pm-info"><b>{t("所属项目：","Project: ")}{str(project?.name)}</b><small>{t("保存后加入此项目，不影响已有视频及其进度。","Existing videos and progress are preserved.")}</small></div>}{type!=="language"&&<label>{type==="project"?t("项目名称","Project name"):t("视频名称","Video name")}<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>}{type==="project"&&<><label>{t("客户","Customer")}<SelectControl locale={locale} required disabled={!!project} value={client} onChange={e=>setClient(e.target.value)}><option value="">{t("请选择已有客户","Choose an existing customer")}</option>{data.clients.filter(c=>c.status!=="Disabled"||c.id===client).map(c=><option key={str(c.id)} value={str(c.id)}>{str(c.name)}</option>)}</SelectControl></label><label>{t("优先级","Priority")}<SelectControl locale={locale} value={priority} onChange={e=>setPriority(e.target.value)}><option value="standard">{t("普通","Normal")}</option><option value="high">{t("高","High")}</option><option value="urgent">{t("紧急","Urgent")}</option></SelectControl></label></>}{type==="video"&&<div className="pm-form-grid"><label>{t("时长（秒）","Duration (seconds)")}<input required type="number" min="1" max="7200" value={duration} onChange={e=>setDuration(e.target.value)}/></label><label>{t("画幅","Aspect ratio")}<SelectControl locale={locale} value={ratio} onChange={e=>setRatio(e.target.value)}>{["16:9","9:16","1:1"].map(value=><option key={value}>{value}</option>)}</SelectControl></label></div>}{(type!=="video"||!original)&&<label>{t("截止日期","Deadline")}<input required type="date" value={due} onChange={e=>setDue(e.target.value)}/></label>}{type!=="project"&&!original&&<fieldset><legend>{t("语言版本（可多选）","Languages (multiple)")}</legend><div className="pm-checks">{languageCodes.map(code=><label key={code}><input type="checkbox" disabled={type==="language"&&data.languages.some(task=>task.video_id===video?.id&&task.language_code===code)} checked={languages.includes(code)} onChange={e=>setLanguages(e.target.checked?[...languages,code]:languages.filter(value=>value!==code))}/>{languageLabel(code,"",locale)}</label>)}</div></fieldset>}{type!=="video"&&<label>{t("制作要求","Production requirements")}<textarea required={type==="project"} value={requirements} onChange={e=>setRequirements(e.target.value)}/></label>}{dateChanged&&dateInventory&&<ProjectDeadlineSync inventory={dateInventory} reviewed={dateReview} onReview={setDateReview} dueDate={due} projectStatus={str(project?.status)} tasks={data.languages} videos={data.videos} locale={locale}/>}{project&&type==="project"&&<p className="pm-info">{t("客户归属保持不变；日期未改变时不执行同步。","Customer ownership is unchanged. Unchanged dates do not trigger synchronization.")}</p>}{error&&<InlineError message={error}/>}</fieldset></form></ProjectModal>;
}

function ProjectTaskDetails({task,data,locale,tab,setTab,onClose,onEdit,onAssign,onLifecycle,renderFile,canManage,assignmentReady,currentProject,onOpenPublisher,mutate}:{assignmentReady:boolean;currentProject:boolean;onOpenPublisher:()=>void;mutate:Mutation;task:Row;data:Platform;locale:Locale;tab:string;setTab:(tab:string)=>void;onClose:()=>void;onEdit:()=>void;onAssign:()=>void;onLifecycle:()=>void;renderFile:(file:Row)=>ReactNode;canManage:boolean}) {
  const zh=locale==="zh",t=(a:string,b:string)=>zh?a:b;
  const project = data.projects.find(p=>p.id === task.project_id);
  const publisherProject = project?.source_system === "deseret_book";
  const publisherStage = stageNames[str(project?.deseret_stage)];
  const revisionFeedback=pendingCustomerRevision(data,task);
  const reports=groupDailyReports(data.checkpoints.filter(row=>row.language_project_id===task.id));
  const files=data.fileRecords.filter(file=>file.language_project_id===task.id&&!file.deleted_at);
  const attachments=(id:unknown):Row[]=>data.checkpointFiles.filter(file=>file.checkpoint_id===id).map(file=>({...file,current_version_id:file.file_version_id}));
  const finals=(data.projectFinalSubmissions||[]).filter(row=>row.language_project_id===task.id);
  const assignments=data.assignmentHistory.filter(row=>row.language_project_id===task.id),handovers=data.handovers.filter(row=>row.language_project_id===task.id);
  const history=[...assignments.map(row=>({...row,kind:"assignment"})),...handovers.map(row=>({...row,kind:"handover"})),...data.audit.filter(row=>row.subject===task.id&&["project.pause","project.resume","project.terminate"].includes(str(row.action))).map(row=>({...row,kind:"status"}))].sort((a:Row,b:Row)=>str(b.created_at).localeCompare(str(a.created_at))) as Row[];
  const person=(email:unknown)=>str(data.team.find(row=>row.email===email)?.name||email)||t("未分配","Unassigned");
  const handoverFiles=(row:Row):Row[]=>{try{const parsed=JSON.parse(str(row.attachments_json)||"[]");return Array.isArray(parsed)?parsed.filter(file=>file&&typeof file==="object"):[];}catch{return [];}};
  return <ProjectModal wide className="pm-task-dialog" title={`${str(task.video_name)} · ${languageLabel(task.language_code,task.language,locale)}`} onClose={onClose} footer={<>{canManage&&<><button onClick={onEdit}>{t("编辑版本信息","Edit version")}</button><button disabled={closed(task)} onClick={onLifecycle}>{task.status==="已暂停"?t("恢复制作","Resume"):t("暂停 / 终止","Pause / terminate")}</button></>}<span className="pm-grow"/>{canManage&&<button className="pm-primary" disabled={closed(task) || !assignmentReady} onClick={onAssign}>{task.editor_email?t("人员调度","Reassign"):t("分配人员","Assign")}</button>}<button onClick={onClose}>{t("关闭","Close")}</button></>}>
    <div className="pm-task-meta"><div><small>{t("业务状态","Status")}</small><Status value={publisherStatus(task) || str(task.status)} locale={locale}/></div><div><small>{t("制作进度","Progress")}</small><Progress value={task.production_progress} locale={locale}/></div><div><small>{t("剪辑师","Editor")}</small><b>{person(task.editor_email)}</b></div><div><small>{t("质检员","Reviewer")}</small><b>{person(task.reviewer_email)}</b></div><div><small>{t("截止日期","Deadline")}</small><b>{dueDate(task.due_date)||"—"}</b></div></div>

    <div className="pm-tabs" role="tablist">{[["overview",t("概览","Overview")],["flow",t("制作流程","Production workflow")],["reports",t("工作日报","Daily reports")],["files",t("任务文件","Task files")],["history",t("人员与交接记录","Assignment & handovers")]].map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel">{revisionFeedback&&<CustomerRevisionReview key={str(revisionFeedback.id)} feedback={revisionFeedback} task={task} locale={locale} mutate={mutate}/>} {tab==="flow" && (publisherProject
      ? <section className="pm-detail-card"><h3>{publisherStage ? t(...publisherStage) : t("出版社审核","Publisher review")}</h3><button className="pm-link" onClick={onOpenPublisher}>{currentProject ? t("查看出版社资料与审核","View publisher brief & review") : t("打开项目","Open project")}</button></section>
      : <ProjectProductionFlow key={str(task.id)} taskId={str(task.id)} locale={locale}/>)} {tab==="overview"&&<div className="pm-task-overview"><section className="pm-detail-card"><h3>{t("当前制作情况","Current production")}</h3><p>{str(task.requirements)}</p><div className="pm-info">{reports[0]?`${reports[0].date} · ${person(reports[0].latest.editor_email)}：${str(reports[0].latest.completed_work)}`:t("尚未提交工作日报。","No daily reports yet.")}</div></section><section className="pm-detail-card"><h3>{t("成片版本记录","Final versions")}</h3>{finals.length?finals.map(row=><div className="pm-record" key={str(row.id)}><b>v{str(row.version_number)} · {person(row.submitted_by)} · {str(row.submitted_at)}</b><p>{str(row.notes)}</p><FileList locale={locale} renderFile={renderFile} files={[{...row,current_version_id:row.final_version_id}]}/></div>):<p className="pm-muted">{t("尚未提交成片","No final version submitted")}</p>}<small>{t("制作进度来自剪辑师填报，业务状态由制作和质检事件更新。","Reported production progress and workflow status are tracked separately.")}</small></section></div>}
    {tab==="reports"&&<>{reports.length?reports.map(report=><article className="pm-record" key={report.date}><div className="pm-record-head"><b>{report.date} · {person(report.latest.editor_email)}</b><Progress value={report.latest.production_progress} locale={locale}/></div><p>{str(report.latest.completed_work)}</p><FileList files={attachments(report.latest.id)} locale={locale} renderFile={renderFile}/>{report.revisions.length>1&&<details><summary>{t(`查看 ${report.revisions.length-1} 次历史修订`,`View ${report.revisions.length-1} earlier revisions`)}</summary>{report.revisions.filter(row=>row.id!==report.latest.id).reverse().map(row=><div className="pm-record" key={str(row.id)}><b>{str(row.created_at)} · {person(row.editor_email)}</b><Progress value={row.production_progress} locale={locale}/><p>{str(row.completed_work)}</p><FileList files={attachments(row.id)} locale={locale} renderFile={renderFile}/></div>)}</details>}</article>):<p className="pm-empty">{t("暂无工作日报","No daily reports")}</p>}</>}
    {tab==="files"&&<><h3>{t("任务文件","Task files")}</h3><FileList files={files} locale={locale} renderFile={renderFile}/><h3>{t("日报与交接附件","Report & handover attachments")}</h3><FileList files={[...new Map(data.checkpointFiles.filter(file=>file.language_project_id===task.id).map(file=>[str(file.file_version_id),{...file,current_version_id:file.file_version_id}])).values()]} locale={locale} renderFile={renderFile}/></>}
    {tab==="history"&&<>{history.length?history.map(row=><article className="pm-record" key={`${row.kind}:${row.id}`}><div className="pm-record-head"><b>{row.kind==="assignment"?t("人员分配 / 调度","Assignment"):row.kind==="handover"?t("交接记录","Handover"):t(str(row.action).replace("project.pause","暂停制作").replace("project.resume","恢复制作").replace("project.terminate","终止版本"),str(row.action))}</b><small>{str(row.created_at)} · {person(row.changed_by||row.initiated_by||row.actor_email)}</small></div>{row.kind==="assignment"?<><p>{t("剪辑师：","Editor: ")}{person(row.previous_editor_email)} → {person(row.new_editor_email)}</p><p>{t("质检员：","Reviewer: ")}{person(row.previous_reviewer_email)} → {person(row.new_reviewer_email)}</p></>:row.kind==="handover"?<><p>{person(row.from_user_email)} → {person(row.to_user_email)} · {str(row.status)}</p><p>{str(row.risk_notes)}</p><p>{row.handover_type==="pm_confirmed"?t("项目管理人员确认后已立即生效","Applied immediately after project manager confirmation"):str(row.accept_notes)}</p><FileList files={[...new Map([...attachments(row.checkpoint_id),...handoverFiles(row)].map(file=>[str(file.file_version_id),file])).values()]} locale={locale} renderFile={renderFile}/></>:null}<p>{str(row.reason||row.details)}</p></article>):<p className="pm-empty">{t("暂无人员或交接记录","No assignment or handover records")}</p>}</>}
    </div>
  </ProjectModal>;
}

function ProjectAssignment({ids,data,locale,mutate,onClose,onDone}:{ids:string[];data:Platform;locale:Locale;mutate:Mutation;onClose:()=>void;onDone:()=>void}) {
  const active = useActiveMaintenanceDialog();
  const zh=locale==="zh",t=(a:string,b:string)=>zh?a:b,formId=useId(),tasks=data.languages.filter(task=>ids.includes(str(task.id)));
  const maxUploadLabel=uploadSizeLabel(useUploadLimit());
  const [role,setRole]=useState(""),[assignee,setAssignee]=useState(""),[reason,setReason]=useState(""),[notes,setNotes]=useState("");
  const [selectedFiles,setSelectedFiles]=useState<string[]>([]),[localFiles,setLocalFiles]=useState<File[]>([]),[uploadTask,setUploadTask]=useState(ids[0]||""),[uploaded,setUploaded]=useState<{file:File;id:string}[]>([]);
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[dirty,setDirty]=useState(false);
  const field=role==="editor"?"editor_email":"reviewer_email",reassign=tasks.some(task=>task[field]);
  const replacements=role?tasks.filter(task=>task[field]).length:0;
  const oversized=tasks.length>20;
  const pending=tasks.some(task=>data.handovers.some(row=>row.language_project_id===task.id&&row.status==="pending"));
  const person=(email:unknown)=>str(data.team.find(row=>row.email===email)?.name||email)||t("未分配","Unassigned");
  const candidates=data.team.filter(person=>person.access_group===(role==="editor"?"production":"quality")&&tasks.every(task=>task[field]!==person.email));
  const attachments:Row[]=[...new Map([...data.fileRecords.filter(file=>ids.includes(str(file.language_project_id))),...data.checkpointFiles.filter(file=>ids.includes(str(file.language_project_id))).map(file=>({...file,current_version_id:file.file_version_id}) as Row)].filter(file=>file.current_version_id).map(file=>[str(file.current_version_id),file])).values()];
  useDraftRisk(busy||dirty);
  const close=()=>{if(!busy&&(!dirty||window.confirm(t("尚未确认，放弃本次人员安排？","Discard this unconfirmed assignment?"))))onClose();};
  const save=async()=>{
    if(!active.current||busy)return;setBusy(true);setError("");
    try {
      const saved=[...uploaded];
      for(const file of localFiles.filter(file=>!saved.some(row=>row.file===file))){
        if(!active.current)return;
        const folder=data.folders.find(folder=>folder.language_project_id===uploadTask&&folder.folder_code==="03.local");
        if(!folder)throw Error(t("找不到交接文件目录，请刷新后重试。","The handover folder is unavailable. Refresh and retry."));
        const body=new FormData();body.set("file",file);body.set("languageProjectId",uploadTask);body.set("folderId",str(folder.id));
        const response=await uploadWithFeedback("/api/files",{method:"POST",body},file),result=await response.json() as {id?:string;error?:string};
        if(!active.current)return;
        if(!response.ok||!result.id)throw Error(result.error||t("上传结果未确认，请先核对文件。","Upload unconfirmed. Check the files first."));
        saved.push({file,id:result.id});setUploaded([...saved]);
      }
      if(!active.current)return;
      const result=await mutate("project.schedule",{targets:JSON.stringify(tasks.map(task=>({id:task.id,revision:Number(task.revision)}))),role,assigneeEmail:assignee,reason:reassign?reason:"",notes:reassign?notes:"",attachmentIds:JSON.stringify([...new Set([...selectedFiles,...saved.map(file=>file.id)])])});
      if(!active.current)return;
      if(result)onDone();else setError(t("人员安排未完成，填写内容已保留。已上传附件保留在任务文件中，请核对后重试。","Assignment was not completed. Input and uploaded task files are retained; review before retrying."));
    }catch(error){setError(error instanceof Error?error.message:t("保存失败","Save failed"));}finally{setBusy(false);}
  };
  return <ProjectModal wide={tasks.length>1} title={tasks.length>1?t("批量人员安排","Batch personnel assignment"):t("人员安排","Personnel assignment")} onClose={close} busy={busy} footer={confirm?<><button disabled={busy} onClick={()=>setConfirm(false)}>{t("返回修改","Back")}</button><button className="pm-primary" disabled={busy||pending||oversized} onClick={()=>void save()}>{busy?t("正在保存…","Saving…"):reassign?t("确认变更并生效","Confirm change"):t("确认分配并生效","Confirm assignment")}</button></>:<><button onClick={close}>{t("取消","Cancel")}</button><button className="pm-primary" type="submit" form={formId} disabled={!role||pending||oversized}>{reassign?t("下一步：确认交接","Next: confirm handover"):t("下一步：确认分配","Next: confirm assignment")}</button></>}>
    <div className="pm-info">{t("以语言版本为分配单位。项目管理人员确认后立即生效，历史日报作者、成片和制作进度保持不变。","Assignments are per language version and apply immediately after the project manager confirms. Report authors, finals and progress are preserved.")}</div>
    {role&&<div className="pm-targets">{tasks.map(task=><div key={str(task.id)}><b>{str(task.project_name)} / {str(task.video_name)} · {languageLabel(task.language_code,task.language,locale)}</b><span>{person(task[field])}{confirm?` → ${person(assignee)}`:""}</span><Progress value={task.production_progress} locale={locale}/></div>)}</div>}
    {oversized&&<p className="pm-danger" role="alert">{t("每次最多安排 20 个语言版本，请分批选择。","Select up to 20 language tasks per batch.")}</p>}
    {pending&&<p className="pm-danger" role="alert">{t("所选任务有历史待确认交接，请先处理已有交接。","A selected task has an existing pending handover. Resolve it first.")}</p>}
    {!confirm&&<div className="pm-role-choices" aria-label={t("选择安排角色","Choose assignment role")}>{(["editor","reviewer"] as const).map(value=>{
      const key=value==="editor"?"editor_email":"reviewer_email",count=tasks.filter(task=>task[key]).length,name=value==="editor"?t("剪辑师","Editor"):t("质检员","Reviewer");
      return <button type="button" key={value} aria-pressed={role===value} onClick={()=>{if(role===value)return;if(dirty&&!window.confirm(t("切换角色将清空当前人员安排表单，继续吗？","Switch roles and clear the current assignment form?")))return;setRole(value);setAssignee("");setReason("");setNotes("");setSelectedFiles([]);setLocalFiles([]);setUploaded([]);setError("");setDirty(false);}}>
        <strong>{name}</strong><span>{tasks.length===1?person(tasks[0][key]):t(`首次分配 ${tasks.length-count} 项 · 更换 ${count} 项`,`${tasks.length-count} initial · ${count} replacements`)}</span><b>{count===0?t(`分配${name}`,`Assign ${name.toLowerCase()}`):count===tasks.length?t(`更换${name}`,`Replace ${name.toLowerCase()}`):t("分配 / 更换","Assign / replace")}</b>
      </button>;
    })}</div>}
    {!role&&<p className="pm-muted">{t("请选择需要安排的角色。首次分配无需填写变更原因；更换已有人员需填写原因和交接说明。","Choose a role. Initial assignment needs no change reason; replacement requires a reason and handover notes.")}</p>}
    {role&&<p className="pm-muted">{t(`首次分配 ${tasks.length-replacements} 项，更换 ${replacements} 项。${reassign?"原因和交接说明仅用于更换人员的任务。":"首次分配无需填写变更原因。"}`,`${tasks.length-replacements} initial, ${replacements} replacements. ${reassign?"Reason and notes apply only to replacements.":"No change reason required."}`)}</p>}
    {confirm?<div className="pm-record"><h3>{reassign?t("交接确认","Confirm handover"):t("分配确认","Confirm assignment")}</h3><p>{role==="editor"?t("剪辑师：","Editor: "):t("质检员：","Reviewer: ")}{person(assignee)}</p>{reassign&&<><p>{t("原因：","Reason: ")}{reason}</p><p>{t("交接说明：","Handover notes: ")}{notes}</p><p>{t(`关联附件 ${selectedFiles.length+localFiles.length} 份；原任务文件和历史记录全部保留。`,`${selectedFiles.length+localFiles.length} attachments; all existing files and history are retained.`)}</p><ul>{attachments.filter(file=>selectedFiles.includes(str(file.current_version_id))).map(file=><li key={str(file.current_version_id)}>{str(file.display_name||file.original_name)}</li>)}{localFiles.map((file,index)=><li key={index}>{file.name}</li>)}</ul></>}<p className="pm-muted">{t("操作人：","Confirmed by: ")}{data.account.name} · {t("立即生效","Effective immediately")}</p></div>:role&&<form id={formId} onChangeCapture={()=>setDirty(true)} onSubmit={event=>{event.preventDefault();setError("");if(!candidates.some(person=>person.email===assignee)){setError(t("请选择有效的负责人","Choose a valid assignee"));return;}setConfirm(true);}}>
      <label>{reassign?t("新负责人","New assignee"):t("负责人","Assignee")}<SelectControl required locale={locale} value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">{t("请选择","Select")}</option>{candidates.map(person=><option key={str(person.email)} value={str(person.email)}>{str(person.name)} · {data.languages.filter(task=>(task.editor_email===person.email||task.reviewer_email===person.email)&&!closed(task)&&task.status!=="已暂停").length} {t("项在办","active")}</option>)}</SelectControl></label>
      {!candidates.length&&<p className="pm-danger">{t("没有可用成员，请调整所选任务或角色。","No available assignees. Adjust the tasks or role.")}</p>}
      {reassign&&<><label>{t("变更原因","Reason")}<textarea required value={reason} maxLength={2000} placeholder={role==="editor"?t("例如：原剪辑师请假，由新剪辑师接续制作","The editor is on leave; another editor will continue production."):t("例如：原质检员请假，由新质检员继续审核","The reviewer is on leave; another reviewer will continue review.")} onChange={e=>setReason(e.target.value)}/></label><label>{t("交接说明","Handover notes")}<textarea required value={notes} maxLength={10000} placeholder={role==="editor"?t("已完成内容、剩余工作、工程文件位置、注意事项","Completed work, remaining work, project files and important notes"):t("已审核内容、待审核版本、未解决问题、审核注意事项","Reviewed work, pending versions, unresolved issues and review notes")} onChange={e=>setNotes(e.target.value)}/></label><fieldset><legend>{t("关联现有日报 / 任务附件","Link existing report / task files")}</legend><div className="pm-attachment-choices">{attachments.map(file=><label key={str(file.current_version_id)}><input type="checkbox" checked={selectedFiles.includes(str(file.current_version_id))} onChange={e=>setSelectedFiles(e.target.checked?[...selectedFiles,str(file.current_version_id)]:selectedFiles.filter(id=>id!==file.current_version_id))}/>{str(file.display_name||file.original_name)}</label>)}{!attachments.length&&<p className="pm-muted">{t("暂无可关联附件","No files to link")}</p>}</div></fieldset>{tasks.length>1&&<label>{t("补充文件所属任务","Task for supplemental files")}<SelectControl locale={locale} disabled={localFiles.length>0} value={uploadTask} onChange={e=>setUploadTask(e.target.value)}>{tasks.map(task=><option value={str(task.id)} key={str(task.id)}>{str(task.video_name)} · {languageLabel(task.language_code,task.language,locale)}</option>)}</SelectControl></label>}<UploadDropzone locale={locale} multiple disabled={busy} title={t("补充交接文件","Supplemental handover files")} hint={t(`可多选 · 单文件须为 1 B–${maxUploadLabel}`,`Multiple files · 1 B–${maxUploadLabel} per file`)} onFiles={files=>{const sizeError=files.map(file=>uploadSizeError(file,directTransferEnabled(),locale)).find(Boolean);if(sizeError){setError(sizeError);return;}setLocalFiles([...localFiles,...files]);}}/><small>{t("确认时才上传并保存到任务文件；若人员变更失败，已上传文件仍保留，可继续关联。","Files upload on confirmation. If assignment fails, uploaded files remain available in the task.")}</small>{!busy&&<UploadQueue locale={locale} items={localFiles.map((file,index)=>({id:String(index),name:file.name,size:file.size,progress:0,phase:uploaded.some(row=>row.file===file)?"completed":"queued"}))} describe={item=>item.phase==="completed"?t("已上传 · 待人员安排确认","Uploaded · assignment pending"):t("待上传","Ready to upload")} remove={id=>setLocalFiles(localFiles.filter((_,index)=>String(index)!==id))}/>}</>}
    </form>}{error&&<InlineError message={error}/>}
  </ProjectModal>;
}

function ProjectLifecycle({task,locale,mutate,onClose}:{task:Row;locale:Locale;mutate:Mutation;onClose:()=>void}) {
  const active = useActiveMaintenanceDialog();
  const zh=locale==="zh",t=(a:string,b:string)=>zh?a:b,id=useId(),pausable=(task.source_system==="deseret_book" && task.status==="待客户预览") || ["待补充资料","待分配","制作中","质检驳回","客户要求修改"].includes(str(task.status));
  const [action,setAction]=useState(task.status==="已暂停"?"project.resume":pausable?"project.pause":"project.terminate"),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  return <ProjectModal title={t("语言版本状态管理","Language task status")} onClose={onClose} busy={busy} footer={<><button disabled={busy} onClick={onClose}>{t("取消","Cancel")}</button><button form={id} type="submit" className="pm-primary" disabled={busy}>{t("确认","Confirm")}</button></>}><form id={id} onSubmit={async event=>{event.preventDefault();if(!active.current||busy)return;setBusy(true);try{const result=await mutate(action,{languageProjectId:str(task.id),notes:reason});if(!active.current)return;if(result)onClose();else setError(t("未能更新，请核对提示后重试。","Update failed. Review the message."));}catch(error){setError(error instanceof Error?error.message:t("未能更新，请重试。","Update failed. Please retry."));}finally{setBusy(false);}}}><p>{str(task.video_name)} · {languageLabel(task.language_code,task.language,locale)}</p><label>{t("操作","Action")}<SelectControl locale={locale} value={action} onChange={e=>setAction(e.target.value)}>{task.status==="已暂停"&&<option value="project.resume">{t("恢复制作","Resume production")}</option>}{pausable&&<option value="project.pause">{t("暂停制作","Pause production")}</option>}<option value="project.terminate">{t("终止版本","Terminate version")}</option></SelectControl></label><label>{t("原因","Reason")}<textarea required value={reason} onChange={e=>setReason(e.target.value)}/></label><p className="pm-info">{action==="project.terminate"?t("终止后锁定人员分配；保留全部历史与文件。","Termination locks assignment; history and files are retained."):t("保留当前进度和人员，恢复后继续原状态。","Progress and assignees are retained; resuming restores the previous status.")}</p>{error&&<InlineError message={error}/>}</form></ProjectModal>;
}
