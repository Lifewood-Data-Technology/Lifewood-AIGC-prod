"use client";
import {FileVideo, FileAudio, FileImage} from "./DirectFileMedia";
import {CoverImage, FrameCover} from "./MediaCover";
import UnfinishedProductionUploads from "./UnfinishedProductionUploads";
import { directTransferEnabled, directUpload, forgetCancelledUpload } from "../lib/direct-upload-client";
import { browserRandomUUID } from "../lib/browser-crypto";


import {categoryUploadPurpose,uploadTypeError,uploadSizeLabel,uploadSizeError} from "../lib/upload-policy";
import {useUploadLimit} from "./useUploadLimit";
import UploadDropzone from "./UploadDropzone";
import UploadQueue from "./UploadQueue";
import DialogSections from "./DialogSections";
import { editorStageLabel, isDeseretSubmissionOpen, submissionNoteRequired, type EditorProductionPhase } from "../lib/deseret-editor-stage";
import {productionFlowStages, flowState, type FlowEvent, type FlowLink} from "../lib/production-flow";
import { groupDailyReports, reportDay, reportDetails, reportStages } from "../lib/daily-reports";
import { loadProductionDraft, productionDraftKey } from "../lib/production-drafts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { workspaceFetch as fetch, tabHeaders } from "../lib/tab-session";
import { productionFileCategories, suggestedProductionCategory, productionBrowseCategory, canSubmitProductionVideo } from "../lib/production-files";
import { progressEditableStatuses } from "../lib/task-file-access";
import { archiveClosedStatuses } from "./DeseretArchivePanel";
import BusinessText from "./BusinessText";
import { languageLabel } from "../lib/business-locale";
import { productionWorkspaceError } from "../lib/production-workspace-errors";
import { useDraftRisk } from "./useLocalDraft";
import { MAX_ACCOUNT_UPLOAD_CONCURRENCY, runUploadWorkers } from "../lib/upload-workers";

type Row = Record<string, unknown>;
type Mode = "materials" | "files" | "daily" | "checkpoint" | "final" | "history" | "handover";
type Target = {flowStage?:string;workDate?:string;taskId:string;mode:Mode;sourceCheckpointId?:string;checkpointMode?:"edit"|"correct";finalVersionId?:string;initialFilter?:"mine";recoveredFileId?:string;archive?:boolean};
type FileRow = { id:string; name:string; mimeType:string; size:number; kind:string; category:string; staged?:boolean; expiresAt?:string; library?:boolean; document?:boolean; purpose?:string; version?:number; createdAt?:string; uploaderName?:string; uploadedBy?:string; currentVersionId?:string; thumbnailRevision?:string|number|null };
// A Deseret scene is submitted with its video and duration only; production scripts are not entered here.
type SceneDraft = {id:string;version:number;duration:string};
type Data = {deseret?:EditorProductionPhase & {scenes:{id:string;version:number;order:number;script?:string;duration:number;fileVersionId:string}[]};pendingFinalVersionId?:string|null;uploadPolicy?:{concurrency:number;requestTimeoutMs:number};flowEvents?:FlowEvent[];flowFiles?:FlowLink[];task:Row;files:FileRow[];libraryFiles?:FileRow[];documents:FileRow[];staged:FileRow[];handovers:Row[];members:Row[];finals:Row[];finalFiles:Row[];checkpoints:Row[];checkpointFiles:Row[]};
type Job = {id:string;file:File;category:string;progress:number;status:"queued"|"waiting"|"uploading"|"ready"|"unconfirmed"|"failed";error?:string;automaticCompletionPaused?:boolean};
const eventName="lifewood-production-workspace";
/** `archive`: the Deseret internal archive upload, a materials form that also records an archive (AIGC only). */
export function openProductionWorkspace(taskId:string, mode:Mode="files", sourceCheckpointId?:string, checkpointMode?:"edit"|"correct", finalVersionId?:string, options?:{archive?:boolean}) { window.dispatchEvent(new CustomEvent(eventName,{detail:{taskId,mode,sourceCheckpointId,checkpointMode,finalVersionId,...(options?.archive&&mode==="materials"?{archive:true}:{})}})); }
export function openFlowUpload(taskId:string,flowStage:string) { window.dispatchEvent(new CustomEvent(eventName,{detail:{taskId,mode:"materials",flowStage}})); }
export function openDailyReport(taskId:string, workDate=reportDay()) { window.dispatchEvent(new CustomEvent(eventName,{detail:{taskId,mode:"daily",workDate}})); }
export function openMyProductionFiles(taskId:string) { window.dispatchEvent(new CustomEvent(eventName,{detail:{taskId,mode:"files",initialFilter:"mine"}})); }
function fileUrl(file:FileRow,download=false) {return `${file.staged?"/api/production-workspace?file=":file.document?"/api/request-documents?id=":"/api/files?id="}${encodeURIComponent(file.id)}${download?"&download=1":""}`;}
function previewable(file:FileRow) {return /^(image|video|audio)\//.test(file.mimeType)||file.mimeType==="application/pdf"||/^text\//.test(file.mimeType);}
const coverSeek=(duration:number)=>duration>0.1?Math.min(.2,duration/2):0;
function FileCover({file}:{file:FileRow}) {
  const [failed,setFailed]=useState(false),[thumbnailFault,setThumbnailFault]=useState(false);
  const fail=()=>setFailed(true),source=fileUrl(file);
  const thumbnail=!file.document&&file.thumbnailRevision&&!thumbnailFault?`${source}&thumbnail=1&revision=${encodeURIComponent(String(file.thumbnailRevision))}`:"";
  if(!failed&&file.mimeType?.startsWith("image/"))return <CoverImage src={source} onFault={fail} onDenied={fail}/>;
  if(!failed&&file.mimeType?.startsWith("video/"))return thumbnail?<CoverImage key={thumbnail} src={thumbnail} onFault={()=>setThumbnailFault(true)} onDenied={fail}/>:<FrameCover src={source} seek={coverSeek} onUnavailable={fail}/>;
  return <span className="production-file-glyph">{file.name.split(".").pop()?.toUpperCase()||"FILE"}</span>;
}

/** Mounted above page navigation: minimising or changing menus never destroys uploads. */
export default function ProductionWorkspace({locale,email,handovers,languages,refresh}:{locale:"zh"|"en";email:string;handovers:Row[];languages:Row[];refresh:()=>void}) {
  const zh=locale==="zh", t=(cn:string,en:string)=>zh?cn:en;
  const maxUploadBytes=useUploadLimit(),maxUploadLabel=uploadSizeLabel(maxUploadBytes);
  const [target,setTarget]=useState<Target|null>(null);
  const [materialsConfirmed,setMaterialsConfirmed]=useState(false);
  const [sceneDraft,setSceneDraft]=useState<SceneDraft>({id:"",version:0,duration:""});
  // A local draft saved by an earlier version may hold `sceneDraft.script`. Its exact text stays in that local draft
  // until the draft is submitted or cleared; it is never shown, never entered and never sent in a new request.
  const [legacySceneScript,setLegacySceneScript]=useState<string|undefined>(undefined);
  const [dailyReportRevisionId,setDailyReportRevisionId]=useState("");
  const [archiveProject,setArchiveProject]=useState(""),[archivePreview,setArchivePreview]=useState("");
  const [reportRevisionId,setReportRevisionId]=useState("");
  const [data,setData]=useState<Data|null>(null), [error,setError]=useState("");
  const submissionClosed = target?.mode === "final" && Boolean(data?.deseret && !isDeseretSubmissionOpen(data.deseret));
  const storyboardSubmission=target?.mode==="final"&&data?.deseret?.stage==="production";
  const invalidScene=storyboardSubmission&&(!Number.isFinite(Number(sceneDraft.duration))||Number(sceneDraft.duration)<=0||Number(sceneDraft.duration)>3600);
  const [minimized,setMinimized]=useState(false),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
  const [percent,setPercent]=useState("0"),[note,setNote]=useState("");
  const [workDate,setWorkDate]=useState(reportDay()),[stage,setStage]=useState("script"),[nextSteps,setNextSteps]=useState("");
  const [pendingDate,setPendingDate]=useState<string|null>(null);
  const [selected,setSelected]=useState<string[]>([]),[categories,setCategories]=useState<Record<string,string>>({}),[finalId,setFinalId]=useState(""),[discarding,setDiscarding]=useState("");
  const [screen,setScreen]=useState<"main"|"picker"|"preview">("main"),[preview,setPreview]=useState<FileRow|null>(null);
  const [pickerStage,setPickerStage]=useState("all");
  const [pendingSelection,setPendingSelection]=useState<string[]>([]),[page,setPage]=useState(0),[filter,setFilter]=useState("all"),[query,setQuery]=useState("");
  const [jobs,setJobs]=useState<Job[]>([]),[result,setResult]=useState<""|"uploaded"|"confirm_final"|"final_saved"|"final_replaced"|"materials_saved"|"archive_saved"|"checkpoint_saved"|"draft_restored"|"pending_restored">("");
  const resultText=result==="pending_restored"?t("上次提交的结果尚未确认，已恢复对应表单。请先点击“核对本次提交结果”，避免重复提交；其他草稿仍保留。","The previous submission is unconfirmed. Its form has been restored. Check this submission before starting another; other drafts are retained."):result==="materials_saved"&&target?.flowStage?t("阶段已完成，文件和历史记录已保存；工作日报仍需单独提交。","Stage completed. Files and history saved; submit your daily report separately."):result==="archive_saved"?t("文件已正式保存并登记为内部留档，仅在 AIGC 内部可见。","Files saved and recorded as an internal archive, visible only inside AIGC."):result==="materials_saved"?t("素材已正式保存，可在任务素材和日报中直接引用。","Materials saved. Reuse them in task materials and daily reports."):result==="uploaded"?t("上传处理结束。请核对每项结果；暂存文件只有提交成功后才进入正式目录。","Uploads processed. Review each outcome; temporary files enter official folders only after submission."):result==="confirm_final"&&storyboardSubmission?t("请选择分镜视频并核对关联资料。","Select the scene video and check its linked materials."):result==="confirm_final"?t("请上传成片并确认关联资料；取消不会保存 100%。","Upload the final and confirm its materials. Cancel does not save 100%."):result==="final_replaced"&&storyboardSubmission?t("待审分镜已更新，质检员已收到通知。","Pending scene updated. The reviewer has been notified."):result==="final_replaced"?t("新版已替换待审成片，质检员已收到版本更新通知。旧版及提交历史可在成片版本中查看。","Pending final replaced. The reviewer has been notified. Previous versions remain in final history."):result==="final_saved"&&storyboardSubmission?t("分镜及关联资料已提交内部质检。","Scene and linked materials submitted for internal QC."):result==="final_saved"?t("成片及关联资料已提交质检。制作进度为 100%，尚未质检通过或交付。","Final and materials submitted for review. Production is 100%; this is not quality approval or delivery."):result==="checkpoint_saved"?t("工作日报已保存，所选附件已归档。","Daily report saved and selected files archived."):"";
  const [historyId,setHistoryId]=useState(""),[viewedCheckpoint,setViewedCheckpoint]=useState("");
  const uploadResultText=jobs.some(job=>job.status==="queued")?t("服务器繁忙，部分文件仍在等待；请稍后点击开始暂存上传。","The server is busy; some files are still queued. Start temporary upload again later."):jobs.some(job=>job.status==="unconfirmed")?t("部分文件上传结果尚未确认，请点击“刷新核对”；不要重复上传。","Some upload results are unconfirmed. Refresh to check; do not upload them again."):jobs.some(job=>job.status==="failed")?t("有文件上传失败，请查看下方文件的错误提示；已成功上传的文件仍保留。","Some files failed to upload. Check the file errors below; successful uploads are retained."):t("文件上传成功，已暂存。请点击底部确认按钮，完成正式保存；仅上传不会完成阶段或提交日报。","Files uploaded successfully and saved temporarily. Use the confirmation button below to save officially; uploading alone does not complete a stage or submit a report.");
  const [mineCategory,setMineCategory]=useState("all"),[audioCategory,setAudioCategory]=useState("all");
  const [alerts,setAlerts]=useState<Row[]>([]),[storageFailed,setStorageFailed]=useState(false);
  const [alertSafe,setAlertSafe]=useState(false),[includeHistory,setIncludeHistory]=useState(false);
  const [attentionPending,setAttentionPending]=useState(false);
  const [confirmDiscard,setConfirmDiscard]=useState(false);
  // File objects cannot be persisted in localStorage. Keep inactive queues in
  // memory, scoped to their exact form, while retaining page-exit protection.
  const parkedJobs=useRef(new Map<string,Job[]>());
  const [parkedRisk,setParkedRisk]=useState(false),[uploading,setUploading]=useState(false),[hasPending,setHasPending]=useState(false);
  const targetRef=useRef(target);useLayoutEffect(()=>{targetRef.current=target;},[target]);
  const queueKey=(value:Target)=>JSON.stringify([value.taskId,value.mode,value.archive?"archive":value.flowStage||"",value.sourceCheckpointId||"",value.checkpointMode||""]);
  useDraftRisk(storageFailed || jobs.some(j=>j.status!=="ready") || parkedRisk || busy,"exit");
  const dismissed=useRef(new Set<string>()), dialog=useRef<HTMLDialogElement>(null), uploadsRunning=useRef(false);
  const pendingRequest=useRef<Record<string,string>|null>(null), draftLoaded=useRef(false);
  const setPending=useCallback((value:Record<string,string>|null)=>{pendingRequest.current=value;setHasPending(Boolean(value));},[]);
  const generation=useRef(0), busyRef=useRef(false), previewOrigin=useRef<"main"|"picker">("main");
  useEffect(()=>()=>{generation.current++;},[]);
  const editing=Boolean(target&&["checkpoint","daily","final","materials"].includes(target.mode)&&(note||nextSteps||sceneDraft.duration||dailyReportRevisionId||selected.length||jobs.length||Number(percent)!==Number(data?.task.production_progress||0)||stage!=="script"));
  const editingRef=useRef(editing);useLayoutEffect(()=>{editingRef.current=editing;},[editing]);
  const jobsRef=useRef(jobs);useLayoutEffect(()=>{jobsRef.current=jobs;},[jobs]);
  const storageFailedRef=useRef(storageFailed);useLayoutEffect(()=>{storageFailedRef.current=storageFailed;},[storageFailed]);
  const draftKey=target?productionDraftKey(email,target.taskId,target.mode,target.archive?"archive":target.flowStage):"";
  const load=useCallback(async(taskId:string,quiet=false)=>{
    const ticket=generation.current;if(!quiet)setLoading(true);
    // Query exact identities before listing ready files. HEAD recovery never
    // repeats PUT and cannot modify an uncertain formal submission's payload.
    if(!pendingRequest.current){
      const ids=jobsRef.current.filter(job=>job.status==="unconfirmed").map(job=>job.id);let index=0;
      const readOnly=quiet?new Set(jobsRef.current.filter(job=>job.automaticCompletionPaused).map(job=>job.id)):new Set<string>();
      await runUploadWorkers(2,()=>ids[index++],async id=>{
        // After bounded promotion recovery, background checks only observe the
        // receipt. An explicit refresh may still resume the original completion.
        try{if(directTransferEnabled())await fetch(`/api/direct-uploads/${encodeURIComponent(id)}`,readOnly.has(id)?{cache:"no-store",signal:AbortSignal.timeout(20000)}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"complete"}),signal:AbortSignal.timeout(20000)});else await fetch(`/api/production-workspace?task=${encodeURIComponent(taskId)}&upload=${encodeURIComponent(id)}`,{cache:"no-store",signal:AbortSignal.timeout(20000)});}catch{/* Keep unconfirmed; the ordinary read below reports access/network errors. */}
      });
    }
    try{const response=await fetch(`/api/production-workspace?task=${encodeURIComponent(taskId)}`,{cache:"no-store"});const body=await response.json() as Data & {error?:string};if(!response.ok)throw new Error(body.error);if(ticket!==generation.current)return null;setData(body);const recovered=jobsRef.current.filter(job=>job.status==="unconfirmed"&&body.staged.some(f=>f.id===job.id));if(recovered.length){setSelected(current=>[...new Set([...current,...recovered.map(j=>j.id)])]);const final=recovered.find(j=>j.category==="final");setCategories(current=>({...Object.fromEntries(Object.entries(current).map(([id,category])=>[id,final&&category==="final"?"video":category])),...Object.fromEntries(recovered.map(j=>[j.id,j.category]))}));if(final)setFinalId(final.id);setMaterialsConfirmed(false);setResult("");}setJobs(current=>current.map(job=>body.staged.some(f=>f.id===job.id)?{...job,status:"ready",progress:100}:job));return body;}
    catch(e){if(ticket===generation.current)setError(e instanceof Error?e.message:"Unable to load task files");return null;}finally{if(!quiet&&ticket===generation.current)setLoading(false);}
  },[]);
  const uncertainKey=jobs.filter(job=>job.status==="unconfirmed").map(job=>job.id).join(",");
  useEffect(()=>{
    const ready=(event:Event)=>{
      const detail=(event as CustomEvent<{status:string;versionId?:string}>).detail;
      if(detail?.status!=='ready'||!detail.versionId)return;
      const revision=Date.now(),update=(files:FileRow[])=>files.map(file=>file.id===detail.versionId?{...file,thumbnailRevision:revision}:file);
      setData(current=>current?{...current,files:update(current.files),staged:update(current.staged),libraryFiles:current.libraryFiles?update(current.libraryFiles):undefined}:current);
    };
    window.addEventListener('lifewood:automatic-preview',ready);return()=>window.removeEventListener('lifewood:automatic-preview',ready);
  },[]);
  useEffect(()=>{
    if(!target||!uncertainKey||busy)return;
    let stopped=false,attempt=0,timer:ReturnType<typeof setTimeout>;
    const taskId=target.taskId,ticket=generation.current;
    const check=async()=>{if(stopped||ticket!==generation.current||pendingRequest.current)return;await load(taskId,true);if(!stopped&&ticket===generation.current&&++attempt<6)timer=setTimeout(()=>void check(),Math.min(30000,5000*2**attempt));};
    timer=setTimeout(()=>void check(),5000);
    return()=>{stopped=true;clearTimeout(timer);};
  },[target,uncertainKey,busy,load]);
  useEffect(()=>{
    const listener=(event:Event)=>{const next=(event as CustomEvent<Target>).detail;
      if(uploadsRunning.current||busyRef.current||pendingRequest.current||storageFailedRef.current){if(pendingRequest.current)setResult("pending_restored");else if(!storageFailedRef.current)setError(locale==="zh"?"当前上传或提交尚未结束，请等待处理完成后再打开其他表单；已选文件会保留。":"The current upload or submission is still running. Wait before opening another form; selected files are retained.");setMinimized(false);return;}
      if(targetRef.current)parkedJobs.current.set(queueKey(targetRef.current),jobsRef.current);
      const nextJobs=parkedJobs.current.get(queueKey(next))||[];
      parkedJobs.current.delete(queueKey(next));jobsRef.current=nextJobs;
      setParkedRisk([...parkedJobs.current.values()].some(queue=>queue.some(job=>job.status!=="ready")));
      generation.current++;
      setPickerStage("all");setMineCategory("all");setAudioCategory("all");setQuery("");
      setConfirmDiscard(false);
      setTarget(next);setMinimized(false);setData(null);setError("");setResult("");setJobs(nextJobs);setArchiveProject("");setArchivePreview("");setScreen("main");setFilter("all");setIncludeHistory(false);setPage(0);setSelected([]);setFinalId("");setHistoryId("");setViewedCheckpoint("");setCategories({});setPending(null);draftLoaded.current=false;
      setSceneDraft({id:browserRandomUUID(),version:0,duration:""});setLegacySceneScript(undefined);
      setPendingDate(null);setReportRevisionId("");setDailyReportRevisionId("");setMaterialsConfirmed(false);setWorkDate(next.workDate||reportDay());setStage("script");setNextSteps("");
      void load(next.taskId).then(value=>{if(!value)return;setPercent(String(Math.min(100,Number(value.task.production_progress)||0)));setNote("");
        if(next.mode==="final"&&value.deseret?.stage==="production"&&["质检驳回","待质检","客户要求修改"].includes(String(value.task.status))){const scene=value.deseret.scenes.find(scene=>scene.fileVersionId===(value.pendingFinalVersionId||value.finals[0]?.final_version_id));if(scene)setSceneDraft({id:scene.id,version:scene.version,duration:String(scene.duration)});}
        if(next.initialFilter)setFilter(next.initialFilter);
        if(next.finalVersionId)setHistoryId(String(value.finals.find(f=>f.final_version_id===next.finalVersionId)?.id||""));
        if(next.mode==="handover"&&value.handovers.length)setFilter("handover");
        if(next.mode==="files"&&next.sourceCheckpointId)setFilter("checkpoint");
        let saved:Record<string,unknown>|null=null;try{saved=loadProductionDraft(localStorage,email,next.taskId,next.mode,next.archive?"archive":next.flowStage);setStorageFailed(false);}catch{setStorageFailed(true);setData(null);return;}
        const savedContext=saved?.context as Partial<Target>|undefined;
        const matchingDraft=!!saved&&(!next.sourceCheckpointId||savedContext?.sourceCheckpointId===next.sourceCheckpointId&&savedContext?.checkpointMode===next.checkpointMode);
        const restore=()=>{if(!saved)return;setReportRevisionId(String(saved.reportRevisionId||""));setPercent(String(saved.percent??0));setNote(String(saved.note));setSelected(saved.selected as string[]);setCategories(saved.categories as Record<string,string>);setFinalId(String(saved.finalId||""));setWorkDate(String(saved.workDate||next.workDate||reportDay()));setStage(String(saved.stage||"script"));setNextSteps(String(saved.nextSteps||""));setDailyReportRevisionId(String(saved.dailyReportRevisionId||""));
          const request = saved.pending as Record<string, unknown> | undefined;
          setArchiveProject(String(request?.archiveProjectVersionId ?? saved.archiveProject ?? ""));
          setArchivePreview(String(request?.archivePreviewVersionId ?? saved.archivePreview ?? ""));
          // A draft saved by an earlier version may still hold a scene script; only the scene identity and duration are restored.
          const restoredScene=saved.sceneDraft as (Partial<SceneDraft>&{script?:unknown})|undefined;if(restoredScene&&typeof restoredScene==="object"&&typeof restoredScene.script==="string")setLegacySceneScript(restoredScene.script);if(restoredScene&&typeof restoredScene.id==="string"&&typeof restoredScene.duration==="string"&&Number.isSafeInteger(restoredScene.version))setSceneDraft({id:restoredScene.id,version:Number(restoredScene.version),duration:restoredScene.duration});
          const restoredMode=savedContext?.mode==="materials"?"materials":savedContext?.mode==="final"||saved.finalId?"final":savedContext?.mode==="daily"?"daily":next.mode;
          setTarget({...next,flowStage:savedContext?.flowStage,mode:restoredMode,sourceCheckpointId:typeof savedContext?.sourceCheckpointId==="string"?savedContext.sourceCheckpointId:undefined,checkpointMode:savedContext?.checkpointMode==="edit"||savedContext?.checkpointMode==="correct"?savedContext.checkpointMode:undefined});
          const pending=saved.pending as Record<string,string>|null;if(pending&&["checkpoint","daily","final","materials","archive"].includes(pending.kind)&&pending.languageProjectId===next.taskId&&pending.submissionId){setPending(pending);setTarget({...next,flowStage:pending.flowStage||undefined,mode:(pending.kind==="archive"?"materials":pending.kind) as Mode,archive:pending.kind==="archive"||undefined,sourceCheckpointId:pending.sourceCheckpointId||undefined,checkpointMode:pending.checkpointMode==="edit"||pending.checkpointMode==="correct"?pending.checkpointMode:undefined});}};
        const source=next.mode==="daily"?groupDailyReports(value.checkpoints).find(report=>report.date===(next.workDate||reportDay()))?.latest:next.sourceCheckpointId?value.checkpoints.find(cp=>cp.id===next.sourceCheckpointId):null;
        if(["checkpoint","daily","final","materials"].includes(next.mode)&&saved?.pending){restore();setResult("pending_restored");}
        else if(["checkpoint","daily","final","materials"].includes(next.mode)&&matchingDraft)restore();
        else if(["checkpoint","daily","final","materials"].includes(next.mode)&&saved){restore();setResult("draft_restored");}
        else if(source){setReportRevisionId(String(source.id));if(next.mode==="daily"){setStage(reportDetails(source).stage||"script");setNextSteps(String(source.next_steps||""));}const members=value.checkpointFiles.filter(m=>m.checkpoint_id===source.id);setPercent(String(source.production_progress??0));setNote(next.mode==="daily"?String(source.completed_work||source.notes||""):[source.completed_work||source.notes,source.pending_work,source.next_steps].filter(Boolean).join("\n"));setSelected(members.map(m=>String(m.file_version_id)));setCategories(Object.fromEntries(members.map(m=>{const file=value.files.find(f=>f.id===m.file_version_id);return [String(m.file_version_id),productionFileCategories.some(c=>c.id===m.file_role)?String(m.file_role):m.file_role==="preview"?"video":suggestedProductionCategory(file?.name||"",file?.mimeType||"")];})));}
        else if(next.mode==="final"&&value.finals.length){const members=value.finalFiles.filter(m=>m.submission_id===value.finals[0].id&&[...value.files,...(value.libraryFiles||[])].some(f=>f.id===m.file_version_id));setSelected(members.map(m=>String(m.file_version_id)));setCategories(Object.fromEntries(members.map(m=>[String(m.file_version_id),String(m.category)])));}

        // Draft restoration must not overwrite uploads confirmed by this read.
        // Never merge anything into an uncertain formal submission: its payload
        // must remain exact for idempotent reconciliation.
        const recovered=nextJobs.filter(job=>job.status==="unconfirmed"&&value.staged.some(file=>file.id===job.id));
        if(!saved?.pending&&recovered.length){
          setSelected(current=>[...new Set([...current,...recovered.map(job=>job.id)])]);
          const recoveredFinal=recovered.find(job=>job.category==="final");
          setCategories(current=>({...Object.fromEntries(Object.entries(current).map(([id,category])=>[id,recoveredFinal&&category==="final"?"video":category])),...Object.fromEntries(recovered.map(job=>[job.id,job.category]))}));
          if(recoveredFinal)setFinalId(recoveredFinal.id);
          setMaterialsConfirmed(false);
        }
        const recoveredFromList=!saved?.pending&&next.recoveredFileId?value.staged.find(file=>file.id===next.recoveredFileId):undefined;
        if(recoveredFromList){setSelected(current=>[...new Set([...current,recoveredFromList.id])]);const category=recoveredFromList.category;setCategories(current=>({...current,[recoveredFromList.id]:category}));if(next.mode==='final'&&category==='final')setFinalId(recoveredFromList.id);setMaterialsConfirmed(false);}
        draftLoaded.current=true;
      });
    };
    window.addEventListener(eventName,listener);return()=>window.removeEventListener(eventName,listener);
  },[email,load,locale,setPending]);
  useEffect(()=>{if(!draftKey||!draftLoaded.current||!target||!["checkpoint","daily","final","materials"].includes(target.mode))return;
    const ticket=generation.current;
    const markStorage=(failed:boolean)=>queueMicrotask(()=>{if(ticket===generation.current)setStorageFailed(failed);});
    if(["checkpoint_saved","final_saved","materials_saved","archive_saved"].includes(result)&&!note&&!nextSteps&&!selected.length&&!jobs.length&&!pendingRequest.current){try{localStorage.removeItem(draftKey);markStorage(false);}catch{markStorage(true);}return;}
    try{if(!note&&!nextSteps&&!sceneDraft.duration&&!legacySceneScript&&!selected.length&&!dailyReportRevisionId&&!pendingRequest.current&&stage==="script"&&workDate===(target.workDate||reportDay())&&Number(percent)===Math.min(100,Number(data?.task.production_progress)||0))localStorage.removeItem(draftKey);else localStorage.setItem(draftKey,JSON.stringify({at:Date.now(),sceneDraft:legacySceneScript===undefined?sceneDraft:{...sceneDraft,script:legacySceneScript},reportRevisionId,dailyReportRevisionId,workDate,stage,nextSteps,percent,note,selected,categories,finalId,...(target.archive?{archiveProject,archivePreview}:{}),context:{mode:target.mode,flowStage:target.flowStage,sourceCheckpointId:target.sourceCheckpointId,checkpointMode:target.checkpointMode},pending:pendingRequest.current}));markStorage(false);}catch{markStorage(true);}
  },[draftKey,archiveProject,archivePreview,sceneDraft,legacySceneScript,reportRevisionId,dailyReportRevisionId,workDate,stage,nextSteps,percent,note,selected,categories,finalId,target,hasPending,busy,data?.task.production_progress,result,jobs.length]);
  useEffect(()=>{
    try{const saved=JSON.parse(sessionStorage.getItem("lifewood-handover-dismissed")||"null");if(saved?.email===email)for(const id of saved.ids||[])dismissed.current.add(String(id));}catch{/* Reminder still works without storage. */}
    const pending=handovers.filter(h=>h.status==="pending"&&h.to_user_email===email&&languages.some(l=>l.id===h.language_project_id&&l.editor_email===email)&&!dismissed.current.has(String(h.id)));
    setAlerts(pending);
  },[handovers,languages,email]);
  useEffect(()=>{if(target||!alerts.length)return;const check=()=>setAlertSafe(!Array.from(document.querySelectorAll('dialog[open],.modal-backdrop,.modal-overlay')).some(node=>node!==dialog.current)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName||""));check();const timer=setInterval(check,1000);return()=>clearInterval(timer);},[target,alerts.length]);
  useEffect(()=>{if(!attentionPending)return;if(!minimized||!target){const timer=setTimeout(()=>setAttentionPending(false),0);return()=>clearTimeout(timer);}const check=()=>{if(document.querySelector('dialog[open],.modal-backdrop,.modal-overlay,form')||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName||""))return;setMinimized(false);setAttentionPending(false);};check();const timer=setInterval(check,1000);return()=>clearInterval(timer);},[attentionPending,minimized,target]);
  const showing=(!minimized&&Boolean(target))||(!target&&alerts.length>0&&alertSafe);
  useEffect(()=>{if(!showing)return;const node=dialog.current,trigger=document.activeElement;node?.showModal();return()=>{node?.close();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus();};},[showing]);
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(uploadsRunning.current||busy||jobs.some(j=>j.status!=="ready")||storageFailed){event.preventDefault();event.returnValue="";}};window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);},[busy,jobs,storageFailed]);
  const allFiles=[...(data?.documents||[]),...(data?.files||[]),...(data?.staged||[]),...(data?.libraryFiles||[])];
  const changeWorkDate=(date:string)=>{
    const source=groupDailyReports(data?.checkpoints||[]).find(report=>report.date===date)?.latest;
    setReportRevisionId(String(source?.id||""));
    const members=(data?.checkpointFiles||[]).filter(m=>m.checkpoint_id===source?.id);
    setWorkDate(date);setStage(source?reportDetails(source).stage||"script":"script");setNextSteps(String(source?.next_steps||""));
    setPercent(String(source?.production_progress??data?.task.production_progress??0));setNote(String(source?.completed_work||source?.notes||""));
    setSelected(members.map(m=>String(m.file_version_id)));setCategories(Object.fromEntries(members.map(m=>{const file=allFiles.find(f=>f.id===m.file_version_id);return [String(m.file_version_id),productionFileCategories.some(c=>c.id===m.file_role)?String(m.file_role):m.file_role==="preview"?"video":suggestedProductionCategory(file?.name||"",file?.mimeType||"")];})));
    setJobs([]);setPendingDate(null);setError("");
  };
  const byId=new Map(allFiles.map(f=>[f.id,f]));
  const categoryLabel=(id:string)=>{const c=productionFileCategories.find(c=>c.id===id||c.code===id);return c?zh?c.zh:c.en:id==="final"?(storyboardSubmission?t("分镜视频","Scene video"):t("成片视频","Final video")):t("请选择分类","Choose category");};
  const metadata=(file:FileRow)=>[`${(Number(file.size)/1024/1024).toFixed(2)} MB`,file.staged?t("暂存 · 未归档","Temporary · not archived"):`v${file.version||1}`,file.uploaderName||file.uploadedBy||"",file.createdAt?new Date(file.createdAt).toLocaleString(zh?"zh-CN":"en-GB",{timeZone:"Asia/Shanghai"}):""].filter(Boolean).join(" · ");
  const openPreview=(file:FileRow)=>{if(/^(image|video|audio)\//.test(file.mimeType)){previewOrigin.current=screen==="picker"?"picker":"main";setPreview(file);setScreen("preview");}else if(previewable(file))window.open(fileUrl(file),"_blank","noopener,noreferrer");};
  const fileCard=(file:FileRow,selectable=false)=><article className={`production-file-card ${selected.includes(file.id)?"selected":""}`} key={file.id}>
    <div className="production-file-cover"><FileCover file={file}/></div><strong title={file.name}>{file.name}</strong><small>{file.library?t("素材库 · ","Source assets from library · "):""}{metadata(file)}</small>
    <div className="production-file-actions">{previewable(file)&&<button type="button" onClick={()=>openPreview(file)}>{t("在线预览","Preview")}</button>}<a href={fileUrl(file,true)}>{t("下载","Download")}</a>
      {selectable&&<button type="button" aria-pressed={pendingSelection.includes(file.id)} onClick={()=>setPendingSelection(current=>current.includes(file.id)?current.filter(id=>id!==file.id):[...current,file.id])}>{pendingSelection.includes(file.id)?t("✓ 已选","✓ Selected"):t("选择","Select")}</button>}
    </div></article>;
  const selectedFileControls=(id:string,showPreview=true)=>{const f=byId.get(id);if(!target)return null;return <>{showPreview&&f&&previewable(f)&&<button type="button" onClick={()=>openPreview(f)}>{t("在线预览","Preview")}</button>}{target.mode==="final"&&f&&canSubmitProductionVideo(f)&&<label><input type="radio" name="final-video" checked={finalId===id} onChange={()=>{setFinalId(id);setMaterialsConfirmed(false);setCategories(c=>({...Object.fromEntries(Object.entries(c).map(([key,value])=>[key,value==="final"?"video":value])),[id]:"final"}));}}/>{storyboardSubmission?t("作为分镜视频","Use as scene video"):t("作为成片","Use as final")}</label>}{id!==finalId&&(!target.archive||f?.staged)&&<select aria-label={t("归档分类","File category")} value={categories[id]||""} onChange={e=>{const category=e.target.value;const error=f?.staged&&category!==f.category&&uploadTypeError({name:f.name,type:f.mimeType},categoryUploadPurpose(category),locale);if(error){setError(error);return;}setError("");setCategories(c=>({...c,[id]:category}));}}><option value="">{categoryLabel("")}</option>{productionFileCategories.map(c=><option key={c.id} value={c.id}>{zh?c.zh:c.en}</option>)}</select>}<button onClick={()=>{setSelected(current=>current.filter(value=>value!==id));setMaterialsConfirmed(false);if(finalId===id)setFinalId("");}}>{t("从本次选择中移除","Remove from selection")}</button>{f?.staged&&(discarding===id?<span className="production-discard-confirm" role="group" aria-label={t("确认丢弃暂存文件","Confirm discarding the temporary file")}><span>{t(`丢弃后服务器上的暂存文件将被永久删除，无法恢复${f.expiresAt?`（否则将于 ${new Date(f.expiresAt).toLocaleString("zh-CN")} 到期）`:""}。`,`The temporary file is permanently deleted from the server and cannot be recovered${f.expiresAt?` (otherwise it expires ${new Date(f.expiresAt).toLocaleString("en-US")})`:""}.`)}</span><button type="button" className="danger" disabled={busy} onClick={()=>void discardStagedFile(id)}>{t("确认丢弃","Discard permanently")}</button><button type="button" disabled={busy} onClick={()=>setDiscarding("")}>{t("保留","Keep")}</button></span>:<button type="button" disabled={busy||uploading} onClick={()=>setDiscarding(id)}>{t("丢弃暂存文件","Discard temporary file")}</button>)}</>;};
  const addFiles=(files:FileList|File[]|null,role?:"final"|"support")=>{if(submissionClosed||!files?.length)return;const sizeError=Array.from(files).map(file=>uploadSizeError(file,directTransferEnabled(),locale)).find(Boolean);if(sizeError){setError(sizeError);return;}const invalid=Array.from(files).map(file=>uploadTypeError(file,categoryUploadPurpose(role==="final"?"final":target?.flowStage||""),locale)).find(Boolean);if(invalid){setError(invalid);return;}if(role==="final"&&(files.length!==1||!files[0].type.startsWith("video/"))){setError(storyboardSubmission?t("请选择一个分镜视频。","Choose one scene video."):t("请选择一个成片视频。","Choose the final video."));return;}setMaterialsConfirmed(false);if(role==="final"){setSelected(current=>current.filter(id=>id!==finalId));setFinalId("");setJobs(current=>current.filter(job=>job.category!=="final"));}setJobs(current=>{let hasFinal=Boolean(finalId)||current.some(j=>j.category==="final");return [...current,...Array.from(files).map(file=>{const category=target?.flowStage|| (role==="final"?"final":role!=="support"&&target?.mode==="final"&&!hasFinal&&file.type.startsWith("video/")?"final":suggestedProductionCategory(file.name,file.type));if(category==="final")hasFinal=true;return {id:browserRandomUUID(),file,category,progress:0,status:"queued" as const};})];});};
  const cancelUploadJob=async(id:string)=>{
    const job=jobsRef.current.find(item=>item.id===id),ticket=generation.current;
    if(!directTransferEnabled()||!job||!['failed','unconfirmed'].includes(job.status)||busyRef.current||uploadsRunning.current)return;
    busyRef.current=true;setBusy(true);setError('');
    try{const response=await fetch(`/api/direct-uploads/${encodeURIComponent(id)}`,{method:'DELETE'}),body=await response.json();if(!response.ok)throw Error(body.error||'Upload cancellation unconfirmed.');forgetCancelledUpload(id);if(ticket===generation.current)setJobs(current=>current.filter(item=>item.id!==id));}
    catch(error){if(ticket===generation.current)setError(productionWorkspaceError(error instanceof Error?error.message:'Upload cancellation unconfirmed.',locale,maxUploadBytes));}
    finally{busyRef.current=false;setBusy(false);}
  };
  // Server-side discard of a finished temporary file; "Remove from selection" stays local and "Cancel upload" is for unfinished uploads.
  const discardStagedFile=async(id:string)=>{
    if(!target||busyRef.current||uploadsRunning.current)return;
    const task=target.taskId,ticket=generation.current;busyRef.current=true;setBusy(true);setError('');
    try{const response=await fetch(`/api/production-workspace?task=${encodeURIComponent(task)}&file=${encodeURIComponent(id)}`,{method:'DELETE'}),body=await response.json();if(!response.ok)throw Error(body.error||'Temporary file discard unconfirmed.');if(ticket===generation.current){setSelected(current=>current.filter(value=>value!==id));setJobs(current=>current.filter(job=>job.id!==id));setMaterialsConfirmed(false);setFinalId(current=>current===id?"":current);setDiscarding("");await load(task,true);}}
    catch(error){if(ticket===generation.current){setDiscarding("");setError(productionWorkspaceError(error instanceof Error?error.message:'Temporary file discard unconfirmed.',locale,maxUploadBytes));void load(task,true);}}
    finally{busyRef.current=false;setBusy(false);}
  };
  const upload=async(retryId?:string,resume=false)=>{
    if(!target||submissionClosed||uploadsRunning.current)return;uploadsRunning.current=true;setUploading(true);
    const task=target.taskId,purpose=target.archive?"archive":target.mode,ticket=generation.current;setError("");setResult("");
    if(resume&&retryId&&directTransferEnabled()){
      const next=jobsRef.current.map(job=>job.id===retryId&&job.status==="unconfirmed"?{...job,status:"queued" as const,error:undefined}:job);jobsRef.current=next;setJobs(next);
    }
    if(retryId){const failed=jobsRef.current.find(job=>job.id===retryId&&job.status==="failed");if(failed){const fresh={...failed,id:browserRandomUUID(),status:"queued" as const,error:undefined,progress:0};const next=jobsRef.current.map(job=>job.id===retryId?fresh:job);jobsRef.current=next;setJobs(next);retryId=fresh.id;}}
    const claimed=new Set<string>(),policy=data?.uploadPolicy;
    const concurrency=policy&&Number.isInteger(policy.concurrency)&&policy.concurrency>=1&&policy.concurrency<=MAX_ACCOUNT_UPLOAD_CONCURRENCY?policy.concurrency:2;
    const timeout=policy&&Number.isInteger(policy.requestTimeoutMs)&&policy.requestTimeoutMs>=150000&&policy.requestTimeoutMs<=720000?policy.requestTimeoutMs:240000;
    const update=(id:string,change:Partial<Job>)=>{if(ticket===generation.current)setJobs(current=>current.map(job=>job.id===id?{...job,...change}:job));};
    try{await runUploadWorkers(concurrency,()=>{
      if(ticket!==generation.current)return;
      const job=jobsRef.current.find(j=>j.status==="queued"&&j.category&&!claimed.has(j.id)&&(!retryId||j.id===retryId));
      if(job)claimed.add(job.id);return job;
    },async job=>{
      const typeError=uploadTypeError(job.file,categoryUploadPurpose(job.category),locale);
      if(typeError){update(job.id,{status:"failed",error:typeError});return;}
      try {
        const form=new FormData();form.set("id",job.id);form.set("task",task);form.set("purpose",purpose);form.set("category",job.category);form.set("file",job.file);
        let body:{file:FileRow}|undefined;
        for(let attempt=0;attempt<4;attempt++){
          update(job.id,{status:"uploading",progress:-1,error:undefined,automaticCompletionPaused:undefined});
          try{if(directTransferEnabled()){
            const response=await directUpload("/api/production-workspace",form,fetch,progress=>update(job.id,{progress}));
            const value=await response.json();
            if(!response.ok)throw Object.assign(new Error(value.error||"Upload not confirmed"),{definite:response.status>=400&&response.status<500&&value.code!=="UPLOAD_UNCONFIRMED",code:value.code,busy:response.status===429&&value.code==="UPLOAD_BUSY",automaticCompletionPaused:["DIRECT_STORAGE_TIMEOUT","DIRECT_STORAGE_CONTROL_TIMEOUT"].includes(value.causeCode)});
            body=value;
          }else body=await new Promise<{file:FileRow}>((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open("POST","/api/production-workspace");xhr.withCredentials=true;Object.entries(tabHeaders()).forEach(([key,value])=>xhr.setRequestHeader(key,value));xhr.timeout=timeout;
            xhr.upload.onprogress=e=>{if(e.lengthComputable)update(job.id,{progress:Math.min(99,Math.round(e.loaded/e.total*100))});};
            xhr.onload=()=>{try{const value=JSON.parse(xhr.responseText);if(xhr.status<200||xhr.status>=300)reject(Object.assign(new Error(value.error||"Upload not confirmed"),{busy:xhr.status===429&&value.code==="UPLOAD_BUSY",definite:xhr.status>=400&&xhr.status<500&&value.code!=="UPLOAD_UNCONFIRMED"}));else if(value.file?.id!==job.id||value.file?.staged!==true)reject(new Error("Upload response identity mismatch"));else resolve(value);}catch{reject(new Error("Upload not confirmed"));}};
            xhr.onerror=xhr.ontimeout=xhr.onabort=()=>reject(new Error("Upload outcome unconfirmed; refresh to check"));xhr.send(form);
          });break;}
          catch(e){if(!(e instanceof Error&&"busy" in e&&e.busy))throw e;update(job.id,{status:"waiting",progress:0});if(attempt===3){update(job.id,{status:"queued",error:e.message||"Upload server busy"});return;}await new Promise(resolve=>setTimeout(resolve,5000));if(ticket!==generation.current)return;}
        }
        if(!body||ticket!==generation.current)return;
        const savedFile=body.file;
        setData(current=>current?{...current,staged:[...current.staged.filter(f=>f.id!==savedFile.id),savedFile]}:current);
        setSelected(current=>[...new Set([...current,savedFile.id])]);setCategories(current=>({...Object.fromEntries(Object.entries(current).map(([id,category])=>[id,job.category==="final"&&category==="final"?"video":category])),[savedFile.id]:job.category}));if(job.category==="final")setFinalId(savedFile.id);
        update(job.id,{progress:100,status:"ready"});
      }catch(e){update(job.id,{status:e instanceof Error&&"definite" in e&&e.definite?"failed":"unconfirmed",error:e instanceof Error?e.message:"Upload unconfirmed",automaticCompletionPaused:e instanceof Error&&"automaticCompletionPaused" in e&&e.automaticCompletionPaused===true});}
    });}finally{uploadsRunning.current=false;setUploading(false);if(ticket===generation.current){setResult("uploaded");setAttentionPending(true);}}
  };
  const replacingFinal = target?.mode==="final" && data?.task.status==="待质检";
  const liveTask = languages.find(task=>task.id===target?.taskId);
  const liveRevision = Number(liveTask?.revision), loadedRevision = Number(data?.task.revision);
  // The workspace read after a successful save can arrive before the refreshed task list.
  const olderLiveTask = Number.isSafeInteger(liveRevision) && liveRevision > 0 && Number.isSafeInteger(loadedRevision) && loadedRevision > 0 && liveRevision < loadedRevision;
  const replacementChanged = Boolean(replacingFinal && liveTask && !olderLiveTask && (
    liveTask.status!==data?.task.status || liveRevision>loadedRevision
  ));
  // The archive form stays open through internal QC and publisher review (not for closed or paused tasks).
  const editableTarget = Boolean(data && !submissionClosed && !replacementChanged && (progressEditableStatuses.includes(String(data.task.status)) || replacingFinal || target?.archive && !archiveClosedStatuses.includes(String(data.task.status))));
  const save=async()=>{
    if(!target||!data||((submissionClosed||replacementChanged)&&!pendingRequest.current)||busy||uploadsRunning.current||jobs.some(j=>j.status!=="ready"))return;
    if(target.mode==="checkpoint"&&Number(percent)===100){setTarget({...target,mode:"final"});setResult("confirm_final");return;}
    busyRef.current=true;setBusy(true);setError("");setResult("");
    const body=pendingRequest.current||{submissionId:browserRandomUUID(),languageProjectId:target.taskId,kind:target.archive?"archive":target.mode,archiveProjectVersionId:target.archive?archiveProject:"",archivePreviewVersionId:target.archive?archivePreview:"",flowStage:target.flowStage||"",dailyReportRevisionId,workDate,stage,nextSteps,reportRevisionId,percent:target.mode==="final"?"100":percent,note,expectedRevision:String(data.task.revision),replacesVersionId:replacingFinal?String(data.pendingFinalVersionId||""):"",fileIds:JSON.stringify(selected),categories:JSON.stringify(categories),finalVersionId:finalId,materialsConfirmed:String(materialsConfirmed),deseretScene:storyboardSubmission?JSON.stringify({id:sceneDraft.id,version:sceneDraft.version,duration:Number(sceneDraft.duration)}):"",checkpointMode:target.checkpointMode||"new",sourceCheckpointId:target.sourceCheckpointId||"",sourceUpdatedAt:String(data.checkpoints.find(cp=>cp.id===target.sourceCheckpointId)?.updated_at||"")};setPending(body);
    try{
      const response=await fetch("/api/production-workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const value=await response.json() as {error?:string;replacedVersionId?:string};if(!response.ok){if(response.status>=400&&response.status<500)setPending(null);throw new Error(value.error);}
      setPending(null);try{localStorage.removeItem(draftKey);if(target.mode!=="materials")localStorage.removeItem(`lifewood-checkpoint-draft:${email}:${target.taskId}`);}catch{/* Optional storage. */}draftLoaded.current=false;setSceneDraft({id:browserRandomUUID(),version:0,duration:""});setLegacySceneScript(undefined);setNote("");setNextSteps("");setSelected([]);setCategories({});setFinalId("");setJobs([]);setArchiveProject("");setArchivePreview("");setResult(target.archive?"archive_saved":target.mode==="materials"?"materials_saved":target.mode==="final"?(value.replacedVersionId?"final_replaced":"final_saved"):"checkpoint_saved");setAttentionPending(true);const current=await load(target.taskId);if(current){setPercent(String(Math.min(100,Number(current.task.production_progress)||0)));setReportRevisionId(String(groupDailyReports(current.checkpoints).find(report=>report.date===workDate)?.latest.id||""));}draftLoaded.current=true;window.dispatchEvent(new Event("lifewood-production-saved"));refresh();
    }catch(e){setError(e instanceof Error?e.message:t("结果未确认，请保留此表单并核对。","Result unconfirmed. Keep this form and check."));}finally{busyRef.current=false;setBusy(false);}
  };
  const rememberDismissal=(ids:string[])=>{ids.forEach(id=>dismissed.current.add(id));try{sessionStorage.setItem("lifewood-handover-dismissed",JSON.stringify({email,ids:[...dismissed.current]}));}catch{/* Optional reminder suppression. */}};
  const dismissAlerts=()=>{rememberDismissal(alerts.map(h=>String(h.id)));setAlerts([]);};
  const close=()=>{if(storageFailed||busy||uploadsRunning.current||pendingRequest.current||jobs.some(j=>j.status!=="ready")){setMinimized(true);return;}generation.current++;setTarget(null);setData(null);setScreen("main");};
  const selectedFinal=data?.finals.find(f=>f.id===historyId)||data?.finals[0];
  const finalVersion=selectedFinal?byId.get(String(selectedFinal.final_version_id)):undefined;
  const handoverIds=new Set((data?.members||[]).map(m=>String(m.file_version_id)));
  const viewedSource=data?.checkpoints.find(cp=>cp.id===target?.sourceCheckpointId);
  const checkpointIds=new Set((data?.checkpointFiles||[]).filter(m=>m.checkpoint_id===viewedSource?.id).map(m=>String(m.file_version_id)));
  const groups=[{id:"all",label:t("全部文件","All files")},{id:"docs",label:t("项目资料","Project documents")},{id:"client",label:t("客户素材","Customer materials")},...(data?.handovers.length?[{id:"handover",label:t("交接资料","Handover files")}]:[]),...(viewedSource?[{id:"checkpoint",label:t("工作日报资料","Checkpoint files")}]:[]),{id:"mine",label:t("我的制作文件","My production files")}];
  const browseFiles=allFiles.filter(f=>(!f.library||filter==="checkpoint"&&checkpointIds.has(f.id)||filter==="handover"&&handoverIds.has(f.id))&&!f.staged&&(filter==="checkpoint"||filter==="handover"||includeHistory||!f.currentVersionId||f.id===f.currentVersionId)).filter(f=>filter==="all"||filter==="docs"&&f.document||filter==="client"&&/^02/.test(f.category)||filter==="handover"&&handoverIds.has(f.id)||filter==="checkpoint"&&checkpointIds.has(f.id)||filter==="mine"&&f.uploadedBy===email).filter(f=>f.name.toLowerCase().includes(query.toLowerCase()));
  const pickerFiles=allFiles.filter(f=>(target?.mode!=="materials"||f.staged||target.archive&&!f.library||target.flowStage&&!f.library&&productionFileCategories.some(c=>c.code===f.category))&&!f.document&&(includeHistory||!f.currentVersionId||f.id===f.currentVersionId||pendingSelection.includes(f.id))).filter(f=>f.name.toLowerCase().includes(query.toLowerCase()));
  const mineCategories=[{id:"all",label:t("全部","All")},...productionFileCategories.filter(c=>!["voice","music"].includes(c.id)).map(c=>({id:c.id,label:zh?c.zh:c.en})),{id:"audio",label:t("音频","Audio")},{id:"other",label:t("其他","Other")},{id:"checkpoints",label:t("日报历史","Report history")}];
  const audioCategories=[{id:"all",label:t("全部音频","All audio")},{id:"voice",label:t("配音","Voiceovers")},{id:"music",label:t("背景音乐","Background music")},{id:"audio",label:t("未分类音频","Unclassified audio")}];
  const stageEvents=new Set(flowState(data?.flowEvents||[]).filter(stage=>pickerStage==="flow"||stage.id===pickerStage).flatMap(stage=>includeHistory?stage.history.filter(e=>e.action==="complete").map(e=>e.id):stage.delivery?[stage.delivery.id]:[]));
  const stageFileIds=new Set((data?.flowFiles||[]).filter(link=>stageEvents.has(link.event_id)).map(link=>link.file_version_id));
  const cards=screen==="picker"?pickerFiles.filter(file=>pickerStage==="all"||stageFileIds.has(file.id)):browseFiles.filter(f=>filter!=="mine"||mineCategory==="all"||(mineCategory==="audio"?["voice","music","audio"].includes(productionBrowseCategory(f))&&(audioCategory==="all"||productionBrowseCategory(f)===audioCategory):productionBrowseCategory(f)===mineCategory));
  const currentPage=Math.min(page,Math.max(0,Math.ceil(cards.length/12)-1));
  const pager=<div className="production-pager" data-dialog-footer><button type="button" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>{t("上一页","Previous")}</button><span>{t(`共 ${cards.length} 个文件`,` ${cards.length} files`)} · {currentPage+1} / {Math.max(1,Math.ceil(cards.length/12))}</span><button type="button" disabled={(currentPage+1)*12>=cards.length} onClick={()=>setPage(currentPage+1)}>{t("下一页","Next")}</button></div>;
  const checkpointHistory = filter === "mine" && mineCategory === "checkpoints";
  const activeDailyReport = target?.mode==="daily"?groupDailyReports(data?.checkpoints||[]).find(report=>report.date===workDate):undefined;
  const historyControl = <label><input type="checkbox" checked={includeHistory} onChange={e=>{setIncludeHistory(e.target.checked);setPage(0);}}/>{t("包含历史版本","Include historical versions")}</label>;
  // A storyboard scene needs only its video and duration; a replacement keeps its required reason (server-checked).
  // Archive engineering file: a new upload filed under Project files, or a saved version really in 03.project.
  const engineeringChoice=(id:string)=>{const file=byId.get(id);return Boolean(file)&&(file?.staged?categories[id]==="project":file?.category==="03.project");};
  const noteRequired=!target||submissionNoteRequired({mode:target.mode,storyboard:Boolean(storyboardSubmission),replacing:Boolean(replacingFinal)});
  const workNotes=<label>{target?.mode==="final"?(replacingFinal?t("替换原因 *","Replacement reason *"):noteRequired?t("本次提交说明 *","Submission notes *"):t("本次提交说明（选填）","Submission notes (optional)")):t("当日工作内容 *","Work completed today *")}<textarea value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label>;
  return <>
    {target&&minimized&&<button className="production-minimized" type="button" onClick={()=>setMinimized(false)}>{jobs.some(j=>j.status==="uploading")?t("文件上传中","Uploading files"):result?t("查看操作结果","View result"):t("返回任务工作区","Return to task workspace")} · {jobs.filter(j=>j.status==="ready").length}/{jobs.length}</button>}
    {showing&&<dialog ref={dialog} data-workflow={data?.deseret ? "deseret" : undefined} className={`modal-card production-workspace-modal ${target&&["daily","final","materials"].includes(target.mode)?"editor-prototype-drawer":""}`} aria-label={t("任务工作区","Task workspace")} onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();if(screen!=="main")setScreen(screen==="preview"?previewOrigin.current:"main");else if(target)close();else dismissAlerts();}}><DialogSections>
      {!target?<><header><h2>{t("你有新的转接任务","You have new handover tasks")}</h2><button onClick={dismissAlerts}>{t("稍后处理","Later")}</button></header><p>{t("可先查看交接资料，再确认接手。稍后处理不会取消任务。","Review the handover files before acknowledging. Later does not cancel the task.")}</p>{alerts.map(h=><article key={String(h.id)}><strong><BusinessText value={String(h.video_name||h.project_name||"")}/></strong><p>{String(h.from_user_name||h.from_user_email)} · <BusinessText value={String(h.reason||"")}/></p><button onClick={()=>{rememberDismissal([String(h.id)]);setAlerts(current=>current.filter(item=>item.id!==h.id));openProductionWorkspace(String(h.language_project_id),"handover");}}>{t("查看交接资料","Review handover")}</button></article>)}</>:<>
        <header><div><span className="eyebrow editor-dialog-brand">Lifewood AIGC</span><h2>{screen==="preview"?preview?.name:screen==="picker"?t("选择已有文件","Choose existing files"):target.flowStage?`${t("上传文件并完成","Upload and complete")} · ${productionFlowStages.find(s=>s.id===target.flowStage)?.[zh?"zh":"en"]}`:target.archive?t("上传工程并留档","Upload engineering file and archive"):target.mode==="materials"?t("上传素材","Upload materials"):target.mode==="daily"?`${t("工作日报","Daily report")} · ${workDate||target.workDate||reportDay()}`:target.mode==="checkpoint"?t("更新进度与工作日报","Daily report"):target.mode==="final"?(storyboardSubmission?t("上传分镜并提交质检","Submit scene for QC"):t("上传成片并提交质检","Upload final for review")):target.mode==="history"?t("成片详情","Final details"):t("任务文件","Task files")}</h2><small><BusinessText value={String(data?.task.client_name||"")}/> · <BusinessText value={String(data?.task.project_name||"")}/> · <BusinessText value={String(data?.task.video_name||"")}/> · {languageLabel(data?.task.language_code,data?.task.language,locale)}</small></div><div><button onClick={()=>setMinimized(true)}>{t("最小化","Minimize")}</button><button onClick={()=>screen!=="main"?setScreen(screen==="preview"?previewOrigin.current:"main"):close()}>{screen!=="main"?t("返回","Back"):t("关闭","Close")}</button></div></header>
        {loading&&<p role="status">{t("正在读取…","Loading…")}</p>}{error&&<p data-dialog-toolbar className="inline-warning" role="alert">{productionWorkspaceError(error,locale,maxUploadBytes)}</p>}{storageFailed&&<p data-dialog-toolbar role="alert">{t("草稿保存失败。请保持页面打开并重试保存。","Your draft could not be saved. Keep this page open and try saving again.")}</p>}{result&&<p data-dialog-toolbar className="production-result" role={result==="uploaded"&&jobs.some(job=>job.status!=="ready")?"alert":"status"}>{result==="uploaded"?uploadResultText:result==="draft_restored"?t("已恢复本任务尚未提交的草稿。请先保存或明确清空，再编辑其他工作日报；原草稿没有被覆盖。","An unsubmitted draft for this task has been restored. Save it or explicitly clear it before editing another report; it has not been overwritten."):resultText}</p>}
        {screen==="preview"&&preview?<div className="production-media">{preview.mimeType.startsWith("video/")?<FileVideo src={fileUrl(preview)} controls autoPlay={false}/>:preview.mimeType.startsWith("audio/")?<FileAudio src={fileUrl(preview)} controls/>:<FileImage src={fileUrl(preview)} alt={preview.name}/>}<a href={fileUrl(preview,true)}>{t("下载","Download")}</a></div>:screen==="picker"?<><div data-dialog-toolbar className="production-search-toolbar"><input aria-label={t("搜索文件","Search files")} value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}} placeholder={t("搜索可选文件名","Search available filenames")}/>{historyControl}{!data?.deseret&&<label className="query-inline-field"><span>{t("制作流程阶段","Workflow stage")}</span><select value={pickerStage} onChange={e=>{setPickerStage(e.target.value);setPage(0);}}><option value="all">{t("全部文件","All files")}</option><option value="flow">{t("全部流程交付物","All workflow deliverables")}</option>{productionFlowStages.map(stage=><option key={stage.id} value={stage.id}>{zh?stage.zh:stage.en}</option>)}</select></label>}</div><div className="production-file-grid">{cards.slice(currentPage*12,currentPage*12+12).map(f=>fileCard(f,true))}</div>{pager}<footer><button onClick={()=>setScreen("main")}>{t("取消","Cancel")}</button><button className="primary-button" onClick={()=>{setSelected(pendingSelection);setMaterialsConfirmed(false);setCategories(current=>{const next={...current};pendingSelection.forEach(id=>{const f=byId.get(id);if(!next[id]&&f)next[id]=productionFileCategories.find(c=>c.code===f.category)?.id||suggestedProductionCategory(f.name,f.mimeType);});return next;});setScreen("main");}}>{t("确认选择","Confirm selection")} ({pendingSelection.length})</button></footer></>:data&&<>
          {["files","handover"].includes(target.mode)&&<>
            {filter==="checkpoint"&&viewedSource&&<section className="production-handover"><strong>{t("工作日报工作说明","Report work notes")}</strong><p><BusinessText value={String(viewedSource.completed_work||viewedSource.notes||"")}/></p></section>}
            {data.handovers.length>0&&filter==="handover"&&data.handovers.map(h=><section className="production-handover" key={String(h.id)}><strong>{String(h.fromName||h.from_user_email)}</strong><p><BusinessText value={String(h.reason||"")}/></p>{!!h.risk_notes&&<p><strong>{t("交接注意事项","Handover notes")}</strong><br/><BusinessText value={String(h.risk_notes)}/></p>}{data.checkpoints.filter(cp=>cp.id===h.checkpoint_id).map(cp=><section key={String(cp.id)}><strong>{t("工作日报工作说明","Report work notes")}</strong>{[cp.completed_work||cp.notes,cp.pending_work,cp.next_steps].filter(Boolean).map((note,index)=><p key={index}><BusinessText value={String(note)}/></p>)}</section>)}{h.status==="pending"&&h.to_user_email===email&&<button disabled={busy} onClick={async()=>{busyRef.current=true;setBusy(true);try{const r=await fetch("/api/workflow",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"production.handover.accept",payload:{handoverId:String(h.id),acceptNotes:""}})});const body=await r.json() as {error?:string};if(!r.ok)throw new Error(body.error);await load(target.taskId);refresh();}catch(e){setError(String(e));}finally{busyRef.current=false;setBusy(false);}}}>{t("确认接手","Confirm handover")}</button>}</section>)}
            <div data-dialog-toolbar className="production-file-toolbar">
              <nav className="production-tabs production-source-tabs" aria-label={t("文件来源","File source")}>{groups.map(g=><button key={g.id} aria-pressed={filter===g.id} onClick={()=>{setFilter(g.id);setQuery("");setPage(0);}}>{g.label}</button>)}</nav>
              <div className="production-toolbar-slot production-toolbar-slot--category" data-active={filter==="mine"}>
                {filter==="mine"?(mineCategory==="audio"?<nav className="production-tabs production-category-tabs production-category-drilldown" aria-label={t("音频分类","Audio categories")}><button onClick={()=>{setMineCategory("all");setAudioCategory("all");setQuery("");setPage(0);}}>{t("制作文件分类","Production file categories")}</button>{audioCategories.map(c=><button key={c.id} aria-pressed={audioCategory===c.id} onClick={()=>{setAudioCategory(c.id);setQuery("");setPage(0);}}>{c.label}</button>)}</nav>:<nav className="production-tabs production-category-tabs" aria-label={t("制作文件分类","Production file categories")}>{mineCategories.map(c=><button key={c.id} aria-pressed={mineCategory===c.id} onClick={()=>{setMineCategory(c.id);setAudioCategory("all");setQuery("");setPage(0);}}>{c.label}</button>)}</nav>):<div className="production-file-scope">{t("当前来源","Current source")} · <strong>{groups.find(group=>group.id===filter)?.label}</strong></div>}
              </div>
              <div className="production-toolbar-slot production-toolbar-slot--search" data-active={!checkpointHistory}>
                {!checkpointHistory&&<div className="production-search-toolbar"><input aria-label={t("搜索文件","Search files")} placeholder={t("搜索当前分类中的文件名","Search filenames in this category")} value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><span className="production-history-control-slot">{!["checkpoint","handover"].includes(filter)&&historyControl}</span></div>}
              </div>
            </div>
            {checkpointHistory?<section>{data.checkpoints.map(cp=><article key={String(cp.id)}><strong>{new Date(String(cp.created_at)).toLocaleString(zh?"zh-CN":"en-GB")} · {String(cp.editor_name||"")}</strong><p><BusinessText value={String(cp.completed_work||cp.notes||"")}/></p><button onClick={()=>{setTarget({...target,sourceCheckpointId:String(cp.id)});setFilter("checkpoint");setPage(0);setQuery("");}}>{t("查看工作日报文件","View report files")}</button></article>)}{!data.checkpoints.length&&<p className="production-empty">{t("暂无日报历史","No report history")}</p>}</section>:<><div className="production-file-grid">{cards.slice(currentPage*12,currentPage*12+12).map(f=>fileCard(f))}</div>{!cards.length&&<p className="production-empty">{query?t("没有匹配的文件，请调整搜索词。","No matching files. Try another search."):filter==="handover"?t("暂无交接附件，可查看交接工作说明。","No handover attachments. Review the handover notes."):t("此分类暂无文件。","No files in this category.")}</p>}{pager}</>}
          </>}
          {target.mode==="history"&&<><nav className="production-tabs">{data.finals.map((f,i)=><button key={String(f.id)} aria-pressed={selectedFinal?.id===f.id} onClick={()=>setHistoryId(String(f.id))}>{i===0?t("当前成片","Current final"):t("历史成片","Previous final")} · v{byId.get(String(f.final_version_id))?.version||1} · {new Date(String(f.submitted_at)).toLocaleDateString(zh?"zh-CN":"en-GB")}</button>)}</nav>{finalVersion?fileCard(finalVersion):<p>{t("暂无新版流程提交的成片。旧成片及质检记录仍在原位置保留。","No final submitted through this workflow yet. Existing finals and reviews remain available in their original locations.")}</p>}<h3>{t("本版关联资料","Materials linked to this version")}</h3>{selectedFinal?.legacy?<p>{t("此成片来自旧版流程，未记录当时的关联资料快照。","This final predates material snapshots; its original associations were not recorded.")}</p>:null}<div className="production-file-grid">{data.finalFiles.filter(m=>m.submission_id===selectedFinal?.id).map(m=>byId.get(String(m.file_version_id))).filter((f):f is FileRow=>!!f).map(f=>fileCard(f))}</div></>}
          {["checkpoint","daily","final","materials"].includes(target.mode)&&<>
            <p>{t(`文件先暂存，确认后提交；暂存保留 7 天。单文件上限 ${maxUploadLabel}。`,`Upload temporarily, then confirm. Temporary files expire after 7 days. Maximum ${maxUploadLabel} per file.`)}</p>
            {!busy&&!hasPending&&!uploading&&<div className="production-file-actions">{confirmDiscard?<><span>{t("仅清空本次未提交的填写和选择；不会删除正式文件或日报历史。","Clear only this unsubmitted form and selection; official files and report history are not deleted.")}</span><button onClick={()=>{try{localStorage.removeItem(draftKey);}catch{setStorageFailed(true);return;}setLegacySceneScript(undefined);setNote("");setNextSteps("");setDailyReportRevisionId("");setSelected([]);setCategories({});setFinalId("");setJobs([]);setPercent(String(Math.min(100,Number(data.task.production_progress)||0)));setResult("");setError("");setConfirmDiscard(false);}}>{t("确认清空","Confirm clear")}</button><button onClick={()=>setConfirmDiscard(false)}>{t("保留草稿","Keep draft")}</button></>:<button onClick={()=>setConfirmDiscard(true)}>{t("清空本次草稿","Clear this draft")}</button>}</div>}
            {submissionClosed&&<div className="workflow-message" role="status">{editorStageLabel(data.deseret?.stage,locale)}</div>}
            {replacementChanged&&<div className="workflow-message bad" role="alert">{t("待审版本或审核状态已更新，替换草稿已保留。请先点击“刷新核对”，确认当前版本后再提交。","The pending version or review status changed. Your replacement draft is retained. Refresh to check the current version before submitting.")}</div>}
            <fieldset disabled={busy||Boolean(hasPending)||!editableTarget}>
              {target.checkpointMode&&<p>{target.checkpointMode==="edit"?t("编辑当前工作日报（保留原编号）","Edit report (keep its number)"):t("更正工作日报（保留原版并新增修订）","Correct report (preserve the original revision)")}</p>}{target.mode==="checkpoint"&&<label>{t("当前视频进度 (%)","Current video progress (%)")}<input type="number" min="0" max="100" value={percent} onChange={e=>setPercent(e.target.value)}/></label>}
              {target.mode==="daily"&&<>{activeDailyReport&&<div className="editor-report-context"><strong>{t(`正在补充 ${workDate} 日报`,`Supplementing the ${workDate} report`)}</strong><span>{t(`保存后将生成修订 ${activeDailyReport.revisions.length+1}，此前 ${activeDailyReport.revisions.length} 个修订会完整保留。`,`Saving creates revision ${activeDailyReport.revisions.length+1}; the previous ${activeDailyReport.revisions.length} revision(s) remain unchanged.`)}</span></div>}<div className="editor-report-fields"><label>{t("工作日期","Work date")}<input type="date" max={reportDay()} value={workDate} disabled={busy||jobs.some(j=>j.status!=="ready")||!!hasPending} onChange={e=>{if(e.target.value!==workDate){if(editingRef.current)setPendingDate(e.target.value);else changeWorkDate(e.target.value);}}}/></label><label>{t("制作阶段","Production stage")}<select value={stage} onChange={e=>setStage(e.target.value)}>{reportStages.map(s=><option key={s[0]} value={s[0]}>{zh?s[1]:s[2]}</option>)}</select></label><div className="editor-report-progress"><label htmlFor="daily-progress-number">{t("累计制作进度 (%)","Cumulative progress (%)")}</label><div className="editor-progress-input"><input aria-label={t("进度滑块","Progress slider")} aria-valuetext={`${percent||0}%`} type="range" min="0" max="100" step="1" style={{"--progress-fill":`${Math.min(100,Math.max(0,Number(percent)||0))}%`} as CSSProperties} value={percent} onChange={e=>setPercent(e.target.value)}/><input id="daily-progress-number" type="number" min="0" max="100" step="1" value={percent} onChange={e=>setPercent(e.target.value===""?"":String(Math.min(100,Math.max(0,Math.round(Number(e.target.value)||0)))))} onBlur={()=>{if(percent==="")setPercent("0");}}/></div></div><p>{t("100% 仅表示制作完成；提交日报不会提交质检。附件选填。","100% means production complete. A daily report does not submit for review. Attachments are optional.")}</p></div></>}
              {target.mode==="daily"&&pendingDate!==null&&<div role="alert" className="editor-date-confirm"><p>{t("切换工作日期将重新载入该日期的日报，当前未提交的填写不会合并；已上传文件仍保留在暂存区。","Switching work date loads that day's report without merging current unsaved edits. Uploaded files remain temporary.")}</p><button type="button" onClick={()=>setPendingDate(null)}>{t("保留当前填写","Keep current edits")}</button><button type="button" onClick={()=>changeWorkDate(pendingDate)}>{t("切换日期并重新载入","Switch date and reload")}</button></div>}
              {!["materials","final"].includes(target.mode)&&workNotes}
              {target.mode==="daily"&&<label>{t("待处理事项 / 明日计划（选填）","Remaining work / next plan (optional)")}<textarea maxLength={1000} value={nextSteps} onChange={e=>setNextSteps(e.target.value)}/></label>}
              {target.mode==="final"&&!data.deseret&&<p>{t("也可选择已有视频作为成片，无需重新上传。","You can use an existing video as the final without re-uploading.")}</p>}
              {directTransferEnabled()&&!submissionClosed&&<UnfinishedProductionUploads key={JSON.stringify([email,target.taskId,target.mode,target.archive?'archive':target.flowStage||''])} locale={locale} taskId={target.taskId} purpose={target.archive?"archive":target.mode} category={target.flowStage} excludeIds={jobs.map(job=>job.id)} disabled={busy||uploading||hasPending} onBusyChange={value=>{busyRef.current=value;setBusy(value);}} onRecovered={(file,category)=>{
                if(pendingRequest.current)return;
                setData(current=>current?{...current,staged:[...current.staged.filter(item=>item.id!==file.id),file]}:current);
                setSelected(current=>[...new Set([...current,file.id])]);setCategories(current=>({...Object.fromEntries(Object.entries(current).map(([id,value])=>[id,category==='final'&&value==='final'?'video':value])),[file.id]:category}));
                if(category==='final')setFinalId(file.id);setMaterialsConfirmed(false);
              }}/>}
              <div className="editor-upload-zones">
                {target.mode==="final"&&<div className="editor-upload-zone" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.target===e.currentTarget&&!busy&&!uploading)addFiles(e.dataTransfer.files,"final");}}><strong>{storyboardSubmission?t("分镜视频 *","Scene video *"):t("成片视频 *","Final video *")}</strong>{!data.deseret&&<p>{t("从本地上传或选择已保存的流程视频，也可以将视频拖到此区域。","Upload a local video, choose a saved workflow video, or drop a video here.")}</p>}<div className="production-file-actions editor-final-file-actions"><UploadDropzone locale={locale} purpose="video" disabled={busy||uploading} onFiles={files=>addFiles(files,"final")} title={storyboardSubmission?t("从本地上传分镜","Choose a scene video"):t("从本地上传成片","Choose a final video")} hint={t(`视频文件 · 单文件不超过 ${maxUploadLabel}`,`Video · up to ${maxUploadLabel} per file`)}/><button type="button" onClick={()=>{setPendingSelection(selected);setPickerStage(data.deseret?"all":"flow");setScreen("picker");setPage(0);setQuery("");}}>{data.deseret?t("选择已有文件","Choose existing files"):t("从制作流程选择","Choose from workflow")}</button></div></div>}
                <div className="editor-upload-zone" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.target===e.currentTarget&&!busy&&!uploading)addFiles(e.dataTransfer.files,target.mode==="final"?"support":undefined);}}><strong>{target.mode==="final"?t("配套文件（选填）","Supporting files (optional)"):target.mode==="materials"?t("上传制作素材","Upload production materials"):t("当日工程文件与素材（选填）","Daily project files and materials (optional)")}</strong><p>{t(`点击选择或拖拽文件；单文件不超过 ${maxUploadLabel}，每次正式提交最多 50 个文件。`,`Choose or drop files; up to ${maxUploadLabel} each and 50 files per submission.`)}</p><div className="production-file-actions"><UploadDropzone locale={locale} purpose={categoryUploadPurpose(target.flowStage||"")} multiple disabled={busy||uploading} onFiles={files=>addFiles(files,target.mode==="final"?"support":undefined)} hint={t(`可多选 · 单文件不超过 ${maxUploadLabel}`,`Multiple files · up to ${maxUploadLabel} per file`)}/><button type="button" onClick={()=>{setPendingSelection(selected);setScreen("picker");setPage(0);setQuery("");}}>{target.mode==="materials"&&!target.flowStage&&!target.archive?t("选择已暂存文件","Choose temporary files"):t("选择已有文件","Choose existing files")}</button></div></div>
              </div>
              {jobs.length>0&&<p role="status">{t("本批文件","This batch")}: {jobs.filter(j=>j.status==="ready").length} / {jobs.length} · {(jobs.reduce((sum,j)=>sum+j.file.size,0)/1048576).toFixed(2)} MB</p>}{!busy&&!uploading&&jobs.some(job=>job.status==="queued")&&<button type="button" className="link-button" onClick={()=>setJobs(current=>current.filter(job=>job.status!=="queued"))}>{t("清空待上传","Clear queued")}</button>}<UploadQueue locale={locale} cancel={busy||uploading?undefined:id=>void cancelUploadJob(id)} items={jobs.map(job=>({id:job.id,uploadId:directTransferEnabled()&&["failed","unconfirmed"].includes(job.status)?job.id:undefined,name:job.file.name,size:job.file.size,progress:job.progress,phase:job.status,error:job.error,retryable:job.status==="failed",resumable:job.status==="unconfirmed"&&directTransferEnabled(),savedFile:job.status==="ready"&&data.staged.some(file=>file.id===job.id)?{id:job.id,storage:"staged" as const,mimeType:data.staged.find(file=>file.id===job.id)!.mimeType}:undefined}))} describe={item=>item.phase==="ready"?t("已暂存 · 待正式确认","Temporary · awaiting confirmation"):item.phase==="failed"?productionWorkspaceError(item.error||"Upload rejected",locale,maxUploadBytes):item.phase==="unconfirmed"?productionWorkspaceError(item.error||t("结果未确认，点击刷新核对","Unconfirmed; refresh to check"),locale):item.phase==="queued"&&item.error?productionWorkspaceError(item.error,locale,maxUploadBytes):item.phase==="waiting"?t("等待服务器上传名额","Waiting for an upload slot"):item.phase==="uploading"?(item.progress<0?t("上传中","Uploading"):`${item.progress}%`):t("等待上传","Queued")} retry={busy||uploading?undefined:id=>void upload(id,jobsRef.current.some(job=>job.id===id&&job.status==="unconfirmed"))} remove={id=>setJobs(current=>current.filter(job=>job.id!==id))} extra={item=>{const job=jobs.find(job=>job.id===item.id)!;if(job.status==="ready"&&selected.includes(job.id))return <div className="production-file-actions">{selectedFileControls(job.id,false)}</div>;return <div className="production-file-actions"><select aria-label={t("上传分类","Upload category")} disabled={job.status!=="queued"} value={job.category} onChange={e=>{const category=e.target.value;const error=category&&uploadTypeError(job.file,categoryUploadPurpose(category),locale);if(error){setError(error);return;}setError("");setJobs(current=>current.map(j=>j.id===job.id?{...j,category}:category==="final"&&j.status==="queued"&&j.category==="final"?{...j,category:"video"}:j));}}><option value="">{t("请选择分类","Choose category")}</option>{target.mode==="final"&&job.file.type.startsWith("video/")&&<option value="final">{storyboardSubmission?t("分镜视频","Scene video"):t("成片视频","Final video")}</option>}{productionFileCategories.map(c=><option key={c.id} value={c.id}>{zh?c.zh:c.en}</option>)}</select>{(job.status==="failed"||job.status==="unconfirmed")&&<button type="button" onClick={()=>setJobs(current=>current.filter(j=>j.id!==job.id))}>{t("移除","Remove")}</button>}</div>;}}/>

              {jobs.some(j=>j.status==="queued")&&<button type="button" disabled={jobs.some(j=>j.status==="queued"&&!j.category)||uploading} onClick={()=>void upload()}>{t("开始暂存上传","Upload temporarily")}</button>}
              <div className="production-selected-files">{selected.filter(id=>!jobs.some(job=>job.id===id&&job.status==="ready")).map(id=>{const f=byId.get(id);return <div key={id}>{f&&<div className="production-file-cover"><FileCover file={f}/></div>}<strong>{f?.name||t("文件不可用，请移除或刷新","Unavailable file; remove or refresh")}</strong>{selectedFileControls(id)}</div>;})}</div>
            {target.archive&&<section className="production-handover" data-section="archive-upload">
              <p>{t("选择本次保存的工程文件（分类为“工程文件”），可选预览视频和下一步。留档仅保存在 AIGC 内部，不会发送给出版社。","Choose the engineering file saved here (category Project files), optionally a preview video and next steps. Archives stay inside AIGC and are never sent to the publisher.")}</p>
              <label>{t("工程文件 *","Engineering file *")}<select value={archiveProject} onChange={e=>setArchiveProject(e.target.value)}><option value="">{t("选择工程文件","Choose the engineering file")}</option>{selected.filter(engineeringChoice).map(id=><option key={id} value={id}>{byId.get(id)?.name||id}</option>)}</select></label>
              <label>{t("预览视频（选填）","Preview video (optional)")}<select value={archivePreview} onChange={e=>setArchivePreview(e.target.value)}><option value="">{t("不选择","None")}</option>{selected.filter(id=>id!==archiveProject&&byId.get(id)?.kind==="video").map(id=><option key={id} value={id}>{byId.get(id)?.name||id}</option>)}</select></label>
              <label>{t("下一步（选填）","Next steps (optional)")}<textarea maxLength={4000} value={nextSteps} onChange={e=>setNextSteps(e.target.value)}/></label>
            </section>}
            {target.mode==="final"&&data.deseret&&<p><button type="button" className="link-button" disabled={busy||uploading||hasPending} onClick={()=>openProductionWorkspace(target.taskId,"materials",undefined,undefined,undefined,{archive:true})}>{t("登记内部留档（工程与下一步，不外发）","Record an internal archive (engineering file and next steps, never sent out)")}</button></p>}
            {target.mode==="final"&&<>
              {replacingFinal&&<p role="status">{t("替换成功后质检员将收到通知，旧版审核将停止。请在说明中填写替换原因，并重新确认本版本的关联资料。","Replacement notifies the reviewer and stops review of the old version. Enter a reason and confirm the new version's materials.")}</p>}
              {workNotes}
            </>}
            {target.mode==="final"&&<label>{t("关联工作日报修订（选填）","Link a daily report revision (optional)")}<select value={dailyReportRevisionId} onChange={e=>setDailyReportRevisionId(e.target.value)}><option value="">{t("不关联","None")}</option>{data.checkpoints.filter(cp=>!["invalidated","failed"].includes(String(cp.status))).map(cp=><option key={String(cp.id)} value={String(cp.id)}>{reportDetails(cp).workDate} · {String(cp.editor_name||"")} · {new Date(String(cp.created_at)).toLocaleString(zh?"zh-CN":"en-GB",{timeZone:"Asia/Shanghai"})}</option>)}</select></label>}
            {storyboardSubmission&&<section className="production-handover">
              <label>{t("分镜","Scene")}<select disabled={busy||hasPending} value={data.deseret?.scenes.some(scene=>scene.id===sceneDraft.id)?sceneDraft.id:""} onChange={e=>{const scene=data.deseret?.scenes.find(scene=>scene.id===e.target.value);setSceneDraft(scene?{id:scene.id,version:scene.version,duration:String(scene.duration)}:{id:browserRandomUUID(),version:0,duration:""});setMaterialsConfirmed(false);}}><option value="">{t("新增分镜","New scene")}</option>{data.deseret?.scenes.map(scene=><option key={scene.id} value={scene.id}>{t("分镜","Scene")} {scene.order} · v{scene.version}</option>)}</select></label>
              <label>{t("时长（秒）","Duration in seconds")}<input required disabled={busy||hasPending} type="number" min="0.01" max="3600" step="0.01" value={sceneDraft.duration} onChange={e=>{setSceneDraft(value=>({...value,duration:e.target.value}));setMaterialsConfirmed(false);}}/></label>
            </section>}
            {target.mode==="final"&&<label className="production-confirm-materials"><input type="checkbox" checked={materialsConfirmed} onChange={e=>setMaterialsConfirmed(e.target.checked)}/>{storyboardSubmission?t("我已核对本次分镜视频及其关联资料。","I have checked this scene video and its linked materials."):t("我已核对成片及本版本所需的关联资料；未更改的资料可沿用已有文件。","I have checked the final and its required materials. Unchanged materials can reuse existing files.")}</label>}
            </fieldset>
            <footer><button type="button" onClick={()=>void load(target.taskId)}>{t("刷新核对","Refresh to check")}</button><button type="button" className="primary-button" disabled={(submissionClosed&&!hasPending)||busy||uploading||jobs.some(j=>j.status!=="ready")||(!hasPending&&((noteRequired&&!note.trim())||(target.mode==="materials"&&!selected.length)||(Boolean(target.archive)&&(!selected.includes(archiveProject)||!engineeringChoice(archiveProject)))||selected.some(id=>!byId.has(id)||(!categories[id]&&id!==finalId&&(!target.archive||byId.get(id)?.staged)))||(target.mode==="final"&&(!finalId||!materialsConfirmed||invalidScene))||!editableTarget))} onClick={()=>void save()}>{busy?t("提交中…","Submitting…"):hasPending?t("核对本次提交结果","Check this submission"):target.flowStage?t("确认文件并完成阶段","Confirm files and complete stage"):target.archive?t("确认保存并留档","Save and archive"):target.mode==="materials"?t("确认保存素材","Confirm and save materials"):target.mode==="final"?(replacingFinal?t("确认替换并通知质检员","Replace and notify reviewer"):t("确认资料并提交质检","Confirm materials and submit for review")):target.mode==="daily"?t("提交日报 / 保存补充","Submit report / supplement"):t("保存进度与工作日报","Save daily report")}</button></footer>
            {target.mode!=="materials"&&data.checkpoints.length>0&&<details><summary>{t("日报历史","Report history")}</summary>{data.checkpoints.map(cp=><article key={String(cp.id)}><button onClick={()=>setViewedCheckpoint(viewedCheckpoint===cp.id?"":String(cp.id))}>{new Date(String(cp.created_at)).toLocaleString(zh?"zh-CN":"en-GB")} · {String(cp.editor_name||"")} · {t("查看文件","View files")}</button><p><BusinessText value={String(cp.completed_work||cp.notes||"")}/></p>{viewedCheckpoint===cp.id&&<div className="production-file-grid">{data.checkpointFiles.filter(m=>m.checkpoint_id===cp.id).map(m=>byId.get(String(m.file_version_id))).filter((f):f is FileRow=>!!f).map(f=>fileCard(f))}</div>}</article>)}</details>}
          </>}
        </>}
      </>}
    </DialogSections></dialog>}
  </>;
}
