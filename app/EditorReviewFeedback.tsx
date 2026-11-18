"use client";
import {FileVideo} from "./DirectFileMedia";

import {useEffect,useRef,useState} from "react";
import BusinessText from "./BusinessText";
import DialogSections from "./DialogSections";

type Row=Record<string,unknown>;
const s=(value:unknown)=>String(value??"");
const read=(value:unknown)=>{try{return JSON.parse(s(value));}catch{return null;}};
const checkLabels=[["content","内容","Content"],["visual","画面","Visuals"],["continuity","连贯性","Continuity"],["audio","音频","Audio"],["copy","文案","Copy"],["brand","品牌","Brand"],["technical","技术规格","Technical"],["compliance","合规","Compliance"]];

type Props={reviews:Row[];reviewId:string;onSelect:(id:string)=>void;locale:"zh"|"en"};
export default function EditorReviewFeedback(props:Props) {
  const current=props.reviews.find(row=>row.id===props.reviewId)||props.reviews[0];
  return <ReviewPanel key={`${s(current?.id)}:${s(current?.file_id)}`} {...props}/>;
}
function ReviewPanel({reviews,reviewId,onSelect,locale}:Props) {
  const t=(cn:string,en:string)=>locale==="zh"?cn:en;
  const review=reviews.find(row=>row.id===reviewId)||reviews[0];
  const [fps,setFps]=useState(25),[head,setHead]=useState(0),[jump,setJump]=useState("");
  const [reportOpen,setReportOpen]=useState(false),[mediaError,setMediaError]=useState(false);
  const player=useRef<HTMLVideoElement>(null),dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(!reportOpen)return;const node=dialog.current,trigger=document.activeElement;node?.showModal();return()=>{node?.close();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus();};},[reportOpen]);
  const rawIssues=read(review?.issues_json),rawChecks=read(review?.checklist_json);
  const issues:Row[]=Array.isArray(rawIssues)?rawIssues:[];
  const checks=rawChecks&&typeof rawChecks==="object"?rawChecks:{};
  const time=(value:unknown)=>value?new Date(s(value)).toLocaleString(locale==="zh"?"zh-CN":"en-GB",{timeZone:"Asia/Shanghai"}):"—";
  const verdict=review?.result==="approved"?t("质检通过","QC approved"):t("需要修改","Changes required");
  const seek=(seconds:number)=>{const video=player.current;if(!video||!Number.isFinite(seconds))return;video.pause();const value=Math.max(0,Math.min(Number.isFinite(video.duration)?video.duration:seconds,seconds));video.currentTime=value;setHead(value);};
  const checklist=<div className="editor-checklist">{checkLabels.map(([key,cn,en])=><span key={key}>{t(cn,en)} · {checks[key]==="pass"?t("通过","Pass"):checks[key]==="fail"?t("不通过","Fail"):checks[key]==="na"?t("不适用","N/A"):"—"}</span>)}</div>;
  const issueCards=(locate:boolean)=>issues.map((issue,index)=><article className="editor-review-issue" key={s(issue.id)||index}>
    {locate&&<button onClick={()=>seek(Number(issue.timeSeconds||0))}>{t("定位","Locate")} {Number(issue.timeSeconds||0).toFixed(2)}s</button>}
    <div><small>{issue.severity==="critical"?t("严重","Critical"):issue.severity==="major"?t("主要","Major"):t("轻微","Minor")} · <BusinessText value={s(issue.category)}/> · {Number(issue.timeSeconds||0).toFixed(2)}s{!!issue.endSeconds&&` – ${Number(issue.endSeconds).toFixed(2)}s`}</small><strong>{index+1}. <BusinessText value={s(issue.description)}/></strong><p><BusinessText value={s(issue.suggestion)}/></p></div>
  </article>);
  return <section className="editor-section editor-quality-layout"><header><h2>{t("质检反馈","Review feedback")}</h2><div className="editor-actions"><select aria-label={t("选择质检轮次","Choose review round")} value={s(review?.id)} onChange={e=>onSelect(e.target.value)}>{reviews.map(row=><option key={s(row.id)} value={s(row.id)}>{t("第","Round ")}{s(row.round_number)}{t(" 轮 · "," · ")}{time(row.created_at)}</option>)}</select>{review&&<button onClick={()=>setReportOpen(true)}>{t("查看质检报告","View review report")}</button>}</div></header>
    {review?<><div className="editor-review-player"><div className="editor-review-stage"><FileVideo key={s(review.file_id)} ref={player} controls preload="metadata" src={`/api/files?id=${encodeURIComponent(s(review.file_id))}`} onError={()=>setMediaError(true)} onTimeUpdate={e=>setHead(e.currentTarget.currentTime)}/>
      {issues.filter(issue=>head>=Number(issue.timeSeconds||0)-.25&&head<=Math.max(Number(issue.timeSeconds||0)+.75,Number(issue.endSeconds||0))).map((issue,index)=>{const position=issue.position as Row|undefined;return position?<button className="editor-review-region" key={s(issue.id)||index} title={s(issue.description)} style={{left:`${Number(position.x)||0}%`,top:`${Number(position.y)||0}%`,width:`${Number(position.width)||8}%`,height:`${Number(position.height)||8}%`}} onClick={()=>seek(Number(issue.timeSeconds||0))}>{issues.indexOf(issue)+1}</button>:null;})}</div>
      {mediaError&&<p role="status">{t("视频暂时无法播放，请核对文件是否可用及当前访问权限。","Video unavailable. Check the file and your access permissions.")}</p>}
      <div className="editor-actions editor-frame-tools"><button onClick={()=>seek(head-5)}>−5s</button><button onClick={()=>seek(head-1/fps)}>{t("上一帧","Previous frame")}</button><span>{head.toFixed(2)}s</span><button onClick={()=>seek(head+1/fps)}>{t("下一帧","Next frame")}</button><button onClick={()=>seek(head+5)}>+5s</button><label>FPS <select value={fps} onChange={e=>setFps(Number(e.target.value))}>{[24,25,30,50,60].map(value=><option key={value}>{value}</option>)}</select></label></div>
      <form className="editor-actions editor-time-jump" onSubmit={e=>{e.preventDefault();if(jump.trim())seek(Number(jump));}}><label>{t("跳转时间（秒）","Jump to time (seconds)")}<input type="number" min="0" step="0.01" value={jump} onChange={e=>setJump(e.target.value)}/></label><button disabled={!jump.trim()||!Number.isFinite(Number(jump))}>{t("跳转","Go")}</button></form>
      <small>{t("按所选帧率估算定位，变帧率视频以播放时间为准。","Frame steps are estimated; use playback time for variable-frame-rate video.")}</small><h3>{t("检查项","Review checklist")}</h3>{checklist}</div>
      <div className="editor-review-content"><h3>{verdict}</h3><p><BusinessText value={s(review.comments)}/></p><small>{s(review.reviewer_name)||t("未记录质检人","Reviewer not recorded")} · {time(review.created_at)}</small><h3>{t("问题清单","Issues")} ({issues.length})</h3>{issueCards(true)}{!issues.length&&<p>{t("本轮未记录逐项问题，请查看总体意见。","No individual issues were recorded. Refer to the overall comments.")}</p>}</div></>:<p className="editor-empty">{t("尚无质检反馈。日报不会触发质检，提交成片后由质检员审核。","No review feedback. Daily reports do not trigger review; submit a final for the reviewer.")}</p>}
    {reportOpen&&review&&<dialog ref={dialog} className="modal-card production-workspace-modal editor-detail-dialog editor-prototype-drawer" onCancel={e=>{e.preventDefault();setReportOpen(false);}}><DialogSections><header><h2>{t("质检报告","Review report")}</h2><button onClick={()=>setReportOpen(false)}>{t("关闭","Close")}</button></header><p>{verdict} · {time(review.created_at)}</p><p>{s(review.reviewer_name)||t("未记录质检人","Reviewer not recorded")}</p><h3>{t("总体意见","Overall comments")}</h3><p><BusinessText value={s(review.comments)}/></p><h3>{t("检查项","Review checklist")}</h3>{checklist}<h3>{t("问题清单","Issues")}</h3>{issueCards(false)}<footer>{review.report_file_id?<a className="primary-button" href={`/api/files?id=${encodeURIComponent(s(review.report_file_id))}&download=1`}>{t("下载 PDF 报告","Download PDF report")}</a>:<span>{t("本轮未保存 PDF 报告。","No PDF report was saved for this review.")}</span>}<button onClick={()=>setReportOpen(false)}>{t("关闭","Close")}</button></footer></DialogSections></dialog>}
  </section>;
}
