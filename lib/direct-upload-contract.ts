import {directUploadMaxBytes} from "./upload-policy";

/** Shared metadata only. Never include signing credentials or URLs in drafts. */
export type DirectUploadFile = { name: string; type: string; size: number; sha256: string };
export type DirectUploadInput = {
  id: string;
  endpoint: "/api/files" | "/api/request-documents" | "/api/production-workspace";
  fields: Record<string, string>;
  file: DirectUploadFile;
  thumbnail?: DirectUploadFile;
};
export const directPartSize = 8 * 1024 * 1024;
export type RecoverableDirectUpload = { input: DirectUploadInput; state: string; busy: boolean; updatedAt: string; expiresAt: string; interrupted?:boolean; expired?:boolean; canCheck?:boolean; canCancel?:boolean; context?:{project:string;task:string;language?:string;languageCode?:string} };
export function isRecoverableDirectUpload(value:unknown):value is RecoverableDirectUpload {
  if(!value||typeof value!=='object')return false;
  const row=value as Record<string,unknown>,input=row.input as Partial<DirectUploadInput>|undefined,file=input?.file;
  if(row.context!==undefined){const context=row.context as {project?:unknown;task?:unknown;language?:unknown;languageCode?:unknown}|null;if(!context||typeof context.project!=='string'||typeof context.task!=='string'||context.project.length>1024||context.task.length>1024||['language','languageCode'].some(key=>{const value=(context as Record<string,unknown>)[key];return value!==undefined&&(typeof value!=='string'||value.length>255);}))return false;}
  const keys=input?.endpoint==='/api/production-workspace'?['task','purpose','category','id']:input?.endpoint==='/api/request-documents'?['requestId']:['languageProjectId','directory','folderId','logicalFileId','scope','assetName','collectionId','relationType','thumbnailForVersionId','forceThumbnail','sourceAssetIds'];
  return Boolean(input&&['/api/production-workspace','/api/request-documents','/api/files'].includes(String(input.endpoint))&&typeof input.id==='string'&&/^[a-f0-9-]{36}$/.test(input.id)&&input.fields&&typeof input.fields==='object'&&!Array.isArray(input.fields)&&Object.entries(input.fields).every(([key,value])=>keys.includes(key)&&typeof value==='string'&&value.length<=12000)&&file&&typeof file.name==='string'&&typeof file.type==='string'&&typeof file.sha256==='string'&&/^[a-f0-9]{64}$/.test(file.sha256)&&Number.isSafeInteger(file.size)&&file.size>0&&file.size<=directUploadMaxBytes&&['created','uploading','verifying','cancelled','expired'].includes(String(row.state))&&typeof row.busy==='boolean'&&typeof row.updatedAt==='string'&&typeof row.expiresAt==='string'&&['interrupted','expired','canCheck','canCancel'].every(key=>row[key]===undefined||typeof row[key]==='boolean'));
}
/** Where an unfinished production upload is confirmed: its own form; a Deseret archive upload reopens the archive form. */
export function productionRecoveryTarget(fields:{task?:string;purpose?:string;id?:string}):{taskId:string;mode:string;archive?:true;recoveredFileId:string} {
  return fields.purpose==='archive'?{taskId:fields.task||'',mode:'materials',archive:true,recoveredFileId:fields.id||''}:{taskId:fields.task||'',mode:fields.purpose||'',recoveredFileId:fields.id||''};
}
export function isRecoverableProductionUpload(value:unknown):value is RecoverableDirectUpload {return isRecoverableDirectUpload(value)&&value.input.endpoint==='/api/production-workspace';}
export function directPartLength(size: number, part: number) {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(part) || part < 1 || part > Math.ceil(size / directPartSize)) throw Error("Invalid upload part");
  return Math.min(directPartSize, size - (part - 1) * directPartSize);
}
