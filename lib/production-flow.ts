export const productionFlowStages = [
  {id:"script",zh:"脚本制作",en:"Script",descriptionZh:"上传脚本、分镜或制作说明。",descriptionEn:"Upload scripts, storyboards or production notes."},
  {id:"image",zh:"图片素材",en:"Images",descriptionZh:"上传本阶段使用的图片和视觉素材。",descriptionEn:"Upload images and visual assets for this stage."},
  {id:"video",zh:"视频素材",en:"Video",descriptionZh:"上传视频素材或制作中的视频版本。",descriptionEn:"Upload video assets or working video versions."},
  {id:"voice",zh:"配音",en:"Voiceover",descriptionZh:"上传配音成品音频。",descriptionEn:"Upload finished voiceover audio."},
  {id:"music",zh:"背景音乐",en:"Music",descriptionZh:"上传背景音乐或音效音频。",descriptionEn:"Upload background music or sound-effect audio."},
] as const;
export type FlowEvent={id:string;stage:string;action:string;task_revision:number;created_at:string;actor_name?:string};
export type FlowLink={event_id:string;file_version_id:string};
export function flowState(events:FlowEvent[]) {
  const ordered=[...events].sort((a,b)=>b.task_revision-a.task_revision);
  return productionFlowStages.map(stage=>{
    const history=ordered.filter(event=>event.stage===stage.id),latest=history[0];
    return {...stage,history,latest,completed:latest?.action==="complete",delivery:history.find(event=>event.action==="complete")};
  });
}
