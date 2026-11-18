"use client";
import {FileVideo} from "./DirectFileMedia";

import {useState, type ReactNode} from "react";
import BusinessText from "./BusinessText";

type Row=Record<string,unknown>;
type File={id:string;name:string;mimeType:string;version?:number};
const s=(value:unknown)=>String(value??"");

/** Version selection changes all three panes together; associations never use the latest file implicitly. */
export default function EditorFinalVersions({submittedVideos=false,finals,files,links,reviews,locale,onReport,onReview,onDownloadFiles,downloading=false,renderFile,renderCover}:{
  submittedVideos?:boolean;finals:Row[];files:File[];links:Row[];reviews:Row[];locale:"zh"|"en";
  onReport:(id:string)=>void;onReview:(id:string)=>void;
  onDownloadFiles?:(ids:string[])=>void;downloading?:boolean;
  renderFile:(id:string)=>ReactNode;renderCover:(id:string)=>ReactNode;
}) {
  const [selected,setSelected]=useState("");
  const t=(cn:string,en:string)=>locale==="zh"?cn:en;
  const current=finals.find(row=>row.id===selected)||finals[0];
  if(!current)return <p className="editor-empty">{submittedVideos?t("尚无送审版本。","No submitted videos yet."):t("暂无成片版本。完成制作后上传首版成片，并提交质检。","No final versions. Upload your first final when production is complete.")}</p>;
  const file=files.find(row=>row.id===current.final_version_id);
  const review=reviews.find(row=>row.file_id===current.final_version_id);
  const status=review?review.result==="approved"?t("质检通过","QC approved"):t("质检未通过","Changes required"):t("待质检","Awaiting review");
  const attached=links.filter(row=>row.submission_id===current.id);
  const time=(value:unknown)=>new Date(s(value)).toLocaleString(locale==="zh"?"zh-CN":"en-GB",{timeZone:"Asia/Shanghai"});
  return <div className="editor-final-layout">
    <section className="editor-section editor-version-rail"><h2>{submittedVideos?t("送审版本","Submitted versions"):t("成片版本","Final versions")} ({finals.length})</h2>
      {finals.map((row,index)=>{const version=files.find(f=>f.id===row.final_version_id);const versionReview=reviews.find(review=>review.file_id===row.final_version_id);return <button key={s(row.id)} aria-pressed={current.id===row.id} onClick={()=>setSelected(s(row.id))}>
        {renderCover(s(row.final_version_id))}<span><strong>v{String(version?.version||index+1).padStart(2,"0")}</strong> {index===0&&<em className="editor-version-latest">{t("最新","Latest")}</em>}<small className="editor-status-badge" data-result={s(versionReview?.result)}>{versionReview?versionReview.result==="approved"?t("质检通过","QC approved"):t("质检未通过","Changes required"):t("待质检","Awaiting review")}</small><small>{time(row.submitted_at)}</small></span>
      </button>;})}
    </section>
    <section className="editor-section editor-final-player"><h2>{file?.name||t("文件不可用","File unavailable")}</h2>
      {file?<FileVideo key={file.id} controls recoverInterruptedPlayback preload="metadata" src={`/api/files?id=${encodeURIComponent(file.id)}`}/>:<p>{t("该文件已删除或无权访问。","This file was removed or is not accessible.")}</p>}
      <h3>{t("配套文件","Supporting files")} ({attached.length})</h3>
      {!!attached.length&&onDownloadFiles&&<button disabled={downloading} onClick={()=>onDownloadFiles(attached.map(row=>s(row.file_version_id)))}>{t("下载全部配套文件","Download all supporting files")}</button>}
      {current.legacy?<p>{submittedVideos?t("此版本未记录关联资料。","No linked materials were recorded for this version."):t("此历史成片未记录关联资料快照。","This legacy final has no recorded material snapshot.")}</p>:attached.length?<div className="editor-file-grid">{attached.map(row=>renderFile(s(row.file_version_id)))}</div>:<p>{t("暂无配套文件","No supporting files")}</p>}
    </section>
    <section className="editor-section editor-final-info"><h2>v{String(file?.version||1).padStart(2,"0")} {t("提交详情","Submission details")}</h2><p className="editor-status-badge" data-result={s(review?.result)}>{status}</p>
      <dl><dt>{t("上传人","Uploaded by")}</dt><dd>{s(current.uploader_name)||t("未记录","Not recorded")}</dd><dt>{t("提交时间","Submitted at")}</dt><dd>{time(current.submitted_at)}</dd><dt>{t("关联工作日报","Linked daily report")}</dt><dd>{current.daily_report_revision_id?<button className="link-button" onClick={()=>onReport(s(current.daily_report_revision_id))}>{t("查看准确修订","View linked revision")}</button>:t("未关联","Not linked")}</dd></dl>
      <h3>{t("本次提交说明","Submission notes")}</h3><p className="editor-pre-wrap"><BusinessText value={s(current.notes)||"—"}/></p>
      <h3>{t("质检信息","Review information")}</h3>{review?<><p>{s(review.reviewer_name)} · {time(review.created_at)}</p><p><BusinessText value={s(review.comments)}/></p><button onClick={()=>onReview(s(review.id))}>{t("查看质检反馈","View review feedback")}</button></>:<p className="editor-empty">{t("等待质检人员处理","Waiting for reviewer")}</p>}
      {file&&<a className="primary-button" href={`/api/files?id=${encodeURIComponent(file.id)}&download=1`}>{submittedVideos?t("下载视频","Download video"):t("下载成片","Download final")}</a>}
    </section>
  </div>;
}
