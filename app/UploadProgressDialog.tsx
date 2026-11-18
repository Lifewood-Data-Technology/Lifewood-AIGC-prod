"use client";
import UploadQueue, {type UploadQueueItem} from "./UploadQueue";
import OperationDialog from "./OperationDialog";
export type ProgressTask = UploadQueueItem;
export default function UploadProgressDialog({ tasks, locale, describe, dismiss, retry, cancel, inline = false, initiallyMinimized = false }: {
  tasks: ProgressTask[]; locale: "zh" | "en"; describe: (task: ProgressTask) => string; dismiss: () => void; retry: (id: string) => void; cancel?:(id:string)=>void; inline?: boolean; initiallyMinimized?: boolean;
}) {
  const zh = locale === "zh", active = tasks.some(task => ["preparing", "uploading", "verifying"].includes(task.phase));
  const success = tasks.filter(task => task.phase === "completed").length, failed = tasks.filter(task => task.phase === "failed").length;
  const uncertain = tasks.filter(task => ["unconfirmed", "interrupted"].includes(task.phase)).length;
  const summary = zh ? `共 ${tasks.length} 项 · 成功 ${success} 项 · 失败 ${failed} 项${uncertain ? ` · 待核对 ${uncertain} 项` : ""}` : `${tasks.length} total · ${success} succeeded · ${failed} failed${uncertain ? ` · ${uncertain} unconfirmed` : ""}`;
  const title = active ? zh ? "正在上传文件" : "Uploading files" : zh ? "上传结果" : "Upload results";
  const content = <div className="upload-progress-content">
      <p className="upload-summary" role="status">{summary}</p>
      <UploadQueue items={tasks} locale={locale} describe={describe} retry={retry} cancel={cancel}/>
      {uncertain > 0 && !tasks.some(task=>task.resumable) && <p role="alert">{zh ? "待核对的文件可能已经保存。请先查看目标位置，确认没有文件后再重试，避免重复上传。" : "Unconfirmed files may already be saved. Check the destination before retrying to avoid duplicates."}</p>}
    </div>;
  if (inline) return <section className="upload-feedback-inline" aria-label={title}><header><h3>{title}</h3>{!active && <button type="button" className="link-button" onClick={dismiss}>{zh ? "收起结果" : "Dismiss results"}</button>}</header>{content}</section>;
  return <OperationDialog title={title} locale={locale} initiallyMinimized={initiallyMinimized} minimizable={active} onClose={active ? undefined : dismiss} closeLabel={zh ? "完成" : "Done"} minimizedLabel={`${active ? title : zh ? "上传已结束，请查看结果" : "Uploads finished — view results"} · ${summary}`} className="upload-result-dialog">{content}</OperationDialog>;
}
