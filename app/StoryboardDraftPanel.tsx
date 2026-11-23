"use client";

import { useState, type ReactNode } from "react";

export type StoryboardDraft = { sceneId: string; fileVersionId: string; sceneVersion: number; duration: number; name: string };
export type SubmittedScene = { id: string; version: number; order: number; duration: number; fileVersionId: string; qualityStatus?: string };
export type StoryboardAction = "storyboard_draft" | "storyboard_remove" | "storyboard_submit";
export type EditingScene = { id: string; version: number; duration: string };

type Props = {
  locale: "zh" | "en";
  drafts: StoryboardDraft[];
  scenes: SubmittedScene[];
  revisionSceneIds: string[];
  revisionOnly: boolean;
  fileNames: ReadonlyMap<string,string>;
  onPreview: (id: string) => void;
  selection: EditingScene;
  videoId: string;
  videos: {id: string; name: string}[];
  revision: number;
  editable: boolean;
  busy: boolean;
  unfinished: boolean;
  editingAllowed: boolean;
  onSelect: (scene: EditingScene | null, videoId: string) => void;
  onDuration: (value: string) => void;
  onVideo: (value: string) => void;
  onAction: (action: StoryboardAction, sceneId?: string) => void;
  upload: ReactNode;
};

export default function StoryboardDraftPanel(props: Props) {
  const { drafts, scenes, selection, videoId, locale, revisionSceneIds } = props;
  const t = (cn: string, en: string) => locale === "zh" ? cn : en;
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const revisable = scenes.filter(scene => scene.qualityStatus === "rejected" || revisionSceneIds.includes(scene.id));
  const legacy = scenes.filter(scene => scene.qualityStatus === "available" && !props.revisionOnly && !revisable.length);
  const choices = [...revisable, ...legacy];
  const existing = scenes.find(scene => scene.id === selection.id);
  const draft = drafts.find(item => item.sceneId === selection.id);
  const reviewed = existing && !choices.includes(existing);
  const requireReplacement = props.revisionOnly || revisable.length > 0;
  const valid = Boolean(videoId && props.videos.some(video => video.id === videoId) && Number(selection.duration) > 0 &&
    Number(selection.duration) <= 3600 && !reviewed && (!requireReplacement || existing) && !(existing && revisable.includes(existing) && videoId === existing.fileVersionId) &&
    !drafts.some(item => item.sceneId !== selection.id && item.fileVersionId === videoId));
  const dirty = Boolean(videoId || selection.duration || props.unfinished);
  const canSubmit = props.editable && drafts.length > 0 && !dirty && !props.busy;
  const canEdit = props.editingAllowed && (!requireReplacement || revisable.length > 0);
  const confirming = canSubmit && confirmation === props.revision;
  const select = (id: string) => {
    const candidate = drafts.find(item => item.sceneId === id);
    const scene = scenes.find(item => item.id === id);
    props.onSelect(candidate ? { id, version: candidate.sceneVersion, duration: String(candidate.duration) } :
      scene ? { id, version: scene.version, duration: String(scene.duration) } : null, candidate?.fileVersionId || (scene && legacy.includes(scene) ? scene.fileVersionId : ""));
    setConfirmation(null);
  };
  return <div className="storyboard-batch">
    {scenes.length > 0 && <section><h3>{t("分镜进度","Scene progress")}</h3><ol>{scenes.map(scene =>
      <li key={scene.id}><strong>{t("分镜","Scene")} {scene.order}{props.fileNames.has(scene.fileVersionId) && <> · {props.fileNames.get(scene.fileVersionId)}</>}</strong><span>{scene.qualityStatus === "available" && !revisable.includes(scene) ? t("未送审","Not submitted") : revisable.includes(scene) ? t("需修改","Changes requested") :
        ["qc_approved","final","delivered"].includes(scene.qualityStatus || "") ? t("已通过","Approved") : t("已送审","Submitted")}</span>{props.fileNames.has(scene.fileVersionId) && <button type="button" onClick={()=>props.onPreview(scene.fileVersionId)}>{t("预览","Preview")}</button>}</li>)}</ol></section>}
    {canEdit && <>
      <fieldset className="production-handover" disabled={!props.editable || props.busy || confirming}>
        <legend>{t("编辑分镜","Edit scene")}</legend>
        <label>{t("分镜","Scene")}<select value={draft || existing ? selection.id : ""} onChange={event => select(event.target.value)}>
          <option value="">{requireReplacement ? t("选择待修改分镜","Choose a scene to revise") : t("新增分镜","New scene")}</option>
          {choices.map(scene => <option key={scene.id} value={scene.id}>{t("分镜","Scene")} {scene.order} · v{scene.version}</option>)}
          {drafts.filter(item => !scenes.some(scene => item.sceneId === scene.id)).map(item => <option key={item.sceneId} value={item.sceneId}>{item.name}</option>)}
        </select></label>
        {props.upload}
        <label>{t("分镜视频","Scene video")}<select value={videoId} onChange={event => props.onVideo(event.target.value)}>
          <option value="">{t("选择视频","Choose a video")}</option>{props.videos.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
        </select></label>
        <label>{t("时长（秒）","Duration in seconds")}<input type="number" min="0.01" max="3600" step="any" value={selection.duration} onChange={event => props.onDuration(event.target.value)}/></label>
        <div className="production-file-actions"><button type="button" className="secondary-button" disabled={!valid || props.unfinished} onClick={() => props.onAction("storyboard_draft")}>{t("保存分镜草稿","Save scene draft")}</button>
          {dirty && <button type="button" disabled={props.unfinished} onClick={() => select("")}>{t("清空当前编辑","Clear current edit")}</button>}</div>
      </fieldset>
      <section><h3>{t("待送质检","Ready to submit")} ({drafts.length})</h3>
        {drafts.length > 0 ? <ol>{drafts.map(item => <li key={item.sceneId}><strong>{item.name || t("视频文件不可用","Video unavailable")}</strong><span>{item.duration} {t("秒","s")}</span>
          {props.fileNames.has(item.fileVersionId) && <button type="button" onClick={() => props.onPreview(item.fileVersionId)}>{t("预览","Preview")}</button>}
          <button type="button" disabled={!props.editable || props.busy || confirming || dirty} onClick={() => select(item.sceneId)}>{t("编辑","Edit")}</button>
          <button type="button" disabled={!props.editable || props.busy || confirming || dirty} onClick={() => props.onAction("storyboard_remove", item.sceneId)}>{t("移除","Remove")}</button></li>)}</ol> :
          <p>{t("尚无已保存的分镜","No saved scenes yet")}</p>}
      </section>
      <div className="production-file-actions">{confirming ? <>
        <strong>{t(`确认将这 ${drafts.length} 个分镜送质检？`,`Submit ${drafts.length} ${drafts.length === 1 ? "scene" : "scenes"} for QC?`)}</strong>
        <button type="button" onClick={() => setConfirmation(null)}>{t("继续编辑","Keep editing")}</button>
        <button type="button" className="primary-button" onClick={() => { setConfirmation(null); props.onAction("storyboard_submit"); }}>{t("确认提交质检","Confirm submission")}</button>
      </> : <button type="button" className="primary-button" disabled={!canSubmit} onClick={() => setConfirmation(props.revision)}>{t("提交质检","Submit for QC")}</button>}</div>
    </>}
  </div>;
}
