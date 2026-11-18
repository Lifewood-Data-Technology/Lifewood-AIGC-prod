"use client";
import {uploadDisplayMime} from "../lib/upload-file-reference";
import {uploadTypeError} from "../lib/upload-policy";
import DialogSections from "./DialogSections";
import { useEffect, useRef, useState } from "react";
import UploadDropzone from "./UploadDropzone";
import UploadQueue, {formatUploadSize,type UploadQueueItem} from "./UploadQueue";
import SelectControl from "./SelectControl";
import { languageLabel } from "../lib/business-locale";
type Row = Record<string, unknown>;
type Props = {
  locale: "zh" | "en"; project: Row; language: Row; folders: Row[];
  uploadFile: (request: { file: File; folderId: string; languageProjectId?: string; directory?: string; onProgress?: (progress:number,phase:"preparing"|"uploading"|"verifying"|"completed"|"failed"|"unconfirmed"|"interrupted")=>void }) => Promise<{ id?:string; ok?: boolean; storageName?:string; error?: string; disposition?: "failed" | "unconfirmed" }>;
  close: () => void; refresh: () => void;
};
export default function SalesAssetUploadDialog({locale, project, language, folders, uploadFile, close, refresh}: Props) {
  const zh = locale === "zh", dialog = useRef<HTMLDialogElement>(null), sending = useRef(false);
  const targets = folders.filter(folder => folder.language_project_id === language.id && !folder.deleted_at && /^02(\.|$)/.test(String(folder.folder_code)) && !String(folder.folder_code).startsWith("02.standards"));
  const [folderId, setFolderId] = useState(String(targets.find(folder => folder.folder_code === "02")?.id || targets[0]?.id || ""));
  const [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [messageKind, setMessageKind] = useState<"status" | "alert">("status");
  const [results,setResults]=useState<UploadQueueItem[]>([]);
  const fileId=(file:File)=>`${file.name}:${file.size}:${file.lastModified}`;
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  const dismiss = () => { if (!sending.current && (!files.length || window.confirm(zh ? "放弃尚未上传的文件选择？" : "Discard the files not yet uploaded?"))) close(); };
  const submit = async (onlyId?:string) => {
    if (sending.current || uncertain || !files.length || !targets.some(folder => String(folder.id) === folderId)) return;
    const invalid=files.map(file=>uploadTypeError(file,"mixed",locale)).find(Boolean);
    if(invalid){setMessage(invalid);setMessageKind("alert");return;}
    sending.current = true; setBusy(true); setMessage(""); setMessageKind("status");
    let completed = 0;
    try {
      for (const file of files.filter(file=>!onlyId||fileId(file)===onlyId)) {
        const id=fileId(file);
        const update=(progress:number,phase:string,error?:string,storageName?:string,savedId?:string)=>setResults(previous=>[...previous.filter(item=>item.id!==id),{id,name:file.name,size:file.size,progress,phase,error,storageName,savedFile:savedId?{id:savedId,storage:"file",mimeType:uploadDisplayMime(file)}:undefined,retryable:phase==="failed"}]);
        update(0,"uploading");
        const result = await uploadFile({ file, folderId, languageProjectId: String(language.id), directory: String(targets.find(folder => String(folder.id) === folderId)?.name || ""), onProgress:(progress,phase)=>update(progress,phase) });
        update(100,result.ok?"completed":result.disposition==="unconfirmed"?"unconfirmed":"failed",result.error,result.storageName,result.ok?result.id:undefined);
        if (!result.ok) {
          setMessageKind("alert");
          if (result.disposition === "unconfirmed") {
            setUncertain(true);
            setMessage(zh ? "本文件上传结果尚未确认，请关闭窗口并查看上传任务状态，避免重复上传。已成功的文件不会重复上传。" : "This upload result is unconfirmed. Close this window and check upload tasks to avoid duplicates. Completed files will not be uploaded again.");
          } else setMessage(zh ? "文件未上传，请检查文件和目标目录后重试。" : result.error || "The file was not uploaded. Check the file and destination, then try again.");
          break;
        }
        completed++; setFiles(previous => previous.filter(item => item !== file));
      }
      if (completed === (onlyId ? 1 : files.length)) { setMessageKind("status"); setMessage(zh ? `已上传 ${completed} 个文件，可继续选择文件或关闭窗口。` : `${completed} files uploaded. Add more files or close this window.`); }
    } catch { setResults(previous=>previous.map(item=>["uploading","verifying","preparing"].includes(item.phase)?{...item,phase:"unconfirmed",retryable:false}:item)); setUncertain(true); setMessageKind("alert"); setMessage(zh ? "连接中断，请关闭窗口并检查上传任务状态，不要重复提交。" : "Connection interrupted. Close this window and check upload tasks before submitting again."); }
    finally { sending.current = false; setBusy(false); refresh(); }
  };
  return <dialog ref={dialog} className="account-access-dialog sales-upload-dialog" data-upload-feedback="local" aria-labelledby="sales-upload-title" onCancel={event => { event.preventDefault(); dismiss(); }}><DialogSections>
    <header><h2 id="sales-upload-title">{zh ? "上传客户素材" : "Upload client assets"}</h2><button className="secondary-button" disabled={busy} onClick={dismiss}>{zh ? "关闭" : "Close"}</button></header>
    <div className="account-access-dialog-body">
      <p className="sales-upload-context">{String(project.client_name || "")} / {String(project.name)} / {String(language.video_name || "")} / {languageLabel(language.language_code, language.language, locale)}</p>

      <label>{zh ? "目标文件夹" : "Destination folder"}<SelectControl locale={locale} value={folderId} disabled={busy || uncertain || !targets.length} onChange={event => setFolderId(event.target.value)}>{targets.map(folder => <option key={String(folder.id)} value={String(folder.id)}>{String(folder[zh ? "name_zh" : "name_en"] || folder.name)}</option>)}</SelectControl></label>
      {!targets.length && <p role="alert">{zh ? "暂无可上传的客户素材目录，请联系项目负责人检查任务。" : "No writable client assets folder is available. Ask the project manager to check the task."}</p>}
      <div hidden={!!message && !files.length}><UploadDropzone locale={locale} multiple disabled={busy || uncertain || !targets.length} onFiles={incoming=>{setResults(previous=>previous.filter(item=>!incoming.some(file=>fileId(file)===item.id)));setFiles(previous=>{const merged=[...previous,...incoming];return merged.filter((file,index)=>merged.findIndex(other=>other.name===file.name&&other.size===file.size&&other.lastModified===file.lastModified)===index);});setMessage("");setMessageKind("status");}}/></div>
      <UploadQueue locale={locale} items={[...results.filter(item=>!files.some(file=>fileId(file)===item.id)),...files.map(file=>results.find(item=>item.id===fileId(file))||{id:fileId(file),name:file.name,size:file.size,phase:"queued",progress:0})]} describe={item=>item.phase==="completed"?(zh?"已保存":"Saved"):item.phase==="queued"?(zh?"待上传":"Ready to upload"):item.phase==="uploading"?`${item.progress}%`:item.phase==="verifying"?(zh?"校验并保存中":"Verifying and saving"):item.phase==="preparing"?(zh?"准备中":"Preparing"):item.phase==="failed"?(zh?"上传失败，请重试":item.error||"Upload failed"):(zh?"结果待核对，请先查看目标文件夹":"Unconfirmed; check the destination first")} remove={busy||uncertain?undefined:id=>setFiles(current=>current.filter(file=>fileId(file)!==id))} retry={busy||uncertain?undefined:id=>void submit(id)}/>

      {message && <p className="sales-upload-message" role={messageKind}>{message}</p>}
    </div>
    <footer><span className="upload-footer-summary">{results.filter(item=>item.phase==="completed").length+files.length} {zh?"个文件":"files"} · {formatUploadSize(results.filter(item=>item.phase==="completed").reduce((sum,item)=>sum+(item.size||0),0)+files.reduce((sum,file)=>sum+file.size,0))}</span>{!busy&&!uncertain&&files.some(file=>!results.some(item=>item.id===fileId(file)))&&<button type="button" className="secondary-button" onClick={()=>setFiles(current=>current.filter(file=>results.some(item=>item.id===fileId(file))))}>{zh?"清空待上传":"Clear queued"}</button>}{!busy && !files.length && message && <button type="button" className="secondary-button" onClick={()=>setMessage("")}>{zh ? "继续上传" : "Add more files"}</button>}{!busy && !files.length && message && <button type="button" className="primary-button" onClick={close}>{zh ? "完成" : "Done"}</button>}{(files.length > 0 || !message) && <button className="primary-button" disabled={busy || uncertain || !files.length || !folderId} onClick={() => void submit()}>{busy ? zh ? "上传中…" : "Uploading…" : zh ? "开始上传" : "Upload files"}</button>}</footer>
  </DialogSections></dialog>;
}
