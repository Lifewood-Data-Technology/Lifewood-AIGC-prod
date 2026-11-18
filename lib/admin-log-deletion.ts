/** Log deletion is irreversible; a server preview freezes the exact record set. */
import {validateLogIds} from './log-query-controls';
export type LogKind = 'audit' | 'login';
export type LogDeletionPreview = {previewId:string;count:number;expiresAt:string;summary:string};
export type LogDeletionReceipt = {submissionId:string;status:'completed';deletedCount:number};
export type LogDeletionCommand =
  | {action:'preview';kind:LogKind;ids?:string[];filters:Record<string,string>}
  | {action:'execute';previewId:string;submissionId:string;confirmation:'永久删除'};
export const LOG_DELETE_LIMIT = 10000;
export const LOG_PREVIEW_TTL_MS = 5 * 60 * 1000;
export function validLogSubmissionId(value:unknown):value is string {
  return typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}
export function parseLogDeletionCommand(value:unknown):LogDeletionCommand {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('Invalid log deletion request.');
  const record=value as Record<string,unknown>;
  if(record.action==='execute'){
    if(Object.keys(record).some(k=>!['action','previewId','submissionId','confirmation'].includes(k)) || !validLogSubmissionId(record.previewId) || !validLogSubmissionId(record.submissionId) || record.confirmation!=='永久删除') throw Error('Confirm permanent deletion with the original preview.');
    return {action:'execute',previewId:record.previewId,submissionId:record.submissionId,confirmation:'永久删除'};
  }
  if(record.action!=='preview' || !['audit','login'].includes(String(record.kind)) || Object.keys(record).some(k=>!['action','kind','ids','filters'].includes(k))) throw Error('Invalid log deletion request.');
  const filters=record.filters;
  if(!filters || typeof filters!=='object' || Array.isArray(filters) || Object.entries(filters).some(([key,v])=>key.length>30 || typeof v!=='string' || v.length>300)) throw Error('Invalid log filters.');
  let ids:string[]|undefined;
  if(record.ids!==undefined){
    if(!Array.isArray(record.ids)||record.ids.some(id=>typeof id!=='string'))throw Error('Invalid selected log records.');
    ids=validateLogIds(record.ids,record.kind==='audit');
  }
  return {action:'preview',kind:record.kind as LogKind,filters:filters as Record<string,string>,...(ids===undefined?{}:{ids})};
}
