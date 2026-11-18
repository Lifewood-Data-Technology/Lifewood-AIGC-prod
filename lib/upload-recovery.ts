/** Technical metadata only: no file bodies, storage paths, handles or signing URLs. */
export type UploadRecordSummary = {id:string;kind:'direct'|'legacy'|'staged';state:string;updatedAt:string;reason:'ACCESS_CHANGED'|'INVALID_METADATA'|'HISTORICAL_RECORD'};
export const uploadRecoveryId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const uploadRecoveryReasons = {
  READY:['可安全废弃','Ready to abandon'],
  CLEANED:['已完成清理','Cleanup complete'],
  REGISTERED:['已有暂存或正式登记，保留文件','A stored or registered file is protected'],
  PROCESSING:['仍有有效处理占用','An active operation is protected'],
  RECENT_ACTIVITY:['上传名额尚未到期，请稍后核对','The upload lease has not expired; check later'],
  INVALID_METADATA:['记录不完整，需核实原始登记','Incomplete metadata; verify the original registration'],
  LEASE_UNKNOWN:['处理占用时间不明，暂不能废弃','The operation lease is unknown; abandonment is blocked'],
  REFERENCE_FOUND:['存在文件引用，保留原文件','A file reference exists; the file is protected'],
  OWNERSHIP_MISMATCH:['存储归属不符，暂不能废弃','Storage ownership differs; abandonment is blocked'],
  COPY_UNCONFIRMED:['旧复制缺少可核实回执，暂不能废弃','The old copy has no verifiable receipt; abandonment is blocked'],
  STORAGE_UNAVAILABLE:['存储核对失败，请稍后重查','Storage verification failed; check again later'],
  LEGACY_MAPPING_MISSING:['旧上传缺少精确存储映射，需补充核对证据','The legacy upload has no exact storage mapping; more evidence is required'],
  ORPHAN_MAPPING_MISSING:['孤立暂存缺少传输回执，需补充核对证据','The orphan staging record has no transfer receipt; more evidence is required'],
  ID_COLLISION:['同编号存在冲突记录，需进一步核对','Conflicting records share this ID; further verification is required'],
} as const;
export type UploadRecoveryReason = keyof typeof uploadRecoveryReasons;
export type UploadRecoveryReview = {
  id:string;kind:'direct'|'legacy'|'staged';owner:string;state:string;updatedAt:string;
  expiresAt:string|null;leaseExpiresAt:string|null;checkedAt:string;review:string;
  reason:UploadRecoveryReason;canAbandon:boolean;
  storage:{objects:number;missing:number;copyReceipts:number}|null;
};
export function uploadRecoveryLabel(reason:UploadRecoveryReason,locale:'zh'|'en') {return uploadRecoveryReasons[reason][locale==='zh'?0:1];}
export function isUploadRecordSummary(value:unknown):value is UploadRecordSummary {
  if(!value||typeof value!=='object')return false;
  const v=value as Record<string,unknown>;
  return typeof v.id==='string'&&v.id.length>0&&v.id.length<=255&&['direct','legacy','staged'].includes(String(v.kind))&&typeof v.state==='string'&&v.state.length<=100&&typeof v.updatedAt==='string'&&['ACCESS_CHANGED','INVALID_METADATA','HISTORICAL_RECORD'].includes(String(v.reason));
}
export function isUploadRecoveryReview(value:unknown):value is UploadRecoveryReview {
  if(!value||typeof value!=='object')return false;
  const v=value as Record<string,unknown>,storage=v.storage;
  return typeof v.id==='string'&&uploadRecoveryId.test(v.id)&&['direct','legacy','staged'].includes(String(v.kind))&&['owner','state','updatedAt','checkedAt','review'].every(key=>typeof v[key]==='string')&&typeof v.review==='string'&&/^[a-f0-9]{64}$/.test(v.review)&&['expiresAt','leaseExpiresAt'].every(key=>v[key]===null||typeof v[key]==='string')&&typeof v.reason==='string'&&Object.hasOwn(uploadRecoveryReasons,v.reason)&&typeof v.canAbandon==='boolean'&&(v.canAbandon===(v.reason==='READY'))&&(storage===null||typeof storage==='object'&&['objects','missing','copyReceipts'].every(key=>Number.isSafeInteger(Reflect.get(storage,key))&&Reflect.get(storage,key)>=0));
}
