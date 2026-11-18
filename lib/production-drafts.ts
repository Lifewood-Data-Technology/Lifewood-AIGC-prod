// Local, non-authoritative drafts. Official reports/files remain server-owned.
import {productionFlowStages} from "./production-flow";
type Draft = Record<string, unknown>;
export function productionDraftKey(email:string, taskId:string, mode:string, flowStage="") {
  return `lifewood-production-draft:${email}:${taskId}${mode==="final"?":final":mode==="materials"?`:materials${flowStage?`:flow:${flowStage}`:""}`:""}`;
}
function read(storage:Storage,key:string):Draft|null {
  const raw=storage.getItem(key);
  let value;try{value=JSON.parse(raw||"null");}catch{return null;}
  return value&&Date.now()-Number(value.at)<7*86400000&&typeof value.note==="string"&&Array.isArray(value.selected)&&value.selected.every((id:unknown)=>typeof id==="string")&&value.categories&&typeof value.categories==="object"?value:null;
}
export function loadProductionDraft(storage:Storage,email:string,taskId:string,mode:string,flowStage=""):Draft|null {
  if(!["checkpoint","daily","final","materials"].includes(mode))return null;
  const reportKey=productionDraftKey(email,taskId,"daily"), finalKey=productionDraftKey(email,taskId,"final");
  const legacy=read(storage,reportKey), context=legacy?.context as Draft|undefined, pending=legacy?.pending as Draft|undefined;
  if(legacy&&(context?.mode==="final"||legacy.finalId||pending?.kind==="final")){
    // Write first: quota/storage failures must never remove the only copy.
    const existing=read(storage,finalKey);
    if(existing&&JSON.stringify(existing)!==JSON.stringify(legacy))throw new Error("Conflicting final drafts");
    storage.setItem(finalKey,JSON.stringify(legacy));
    storage.removeItem(reportKey);
  }
  const modes=[mode,...["daily","final","materials"].filter(item=>item!==mode)];
  const keys=[productionDraftKey(email,taskId,mode,flowStage),...modes.map(item=>productionDraftKey(email,taskId,item)),...productionFlowStages.map(stage=>productionDraftKey(email,taskId,"materials",stage.id))];
  const drafts=[...new Set(keys)].map(key=>read(storage,key));
  // An uncertain POST is reconciled using its exact original payload, even when
  // another entry was clicked. Never create a new submission to bypass it.
  return drafts.find(draft=>{
    const request=draft?.pending as Draft|undefined;
    return request&&["checkpoint","daily","final","materials"].includes(String(request.kind))&&request.languageProjectId===taskId&&request.submissionId;
  })||drafts[0];
}
