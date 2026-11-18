"use client";
import type {UploadRecordSummary} from '../lib/upload-recovery';
export default function UploadRecordSummaries({records,locale}:{records:UploadRecordSummary[];locale:'zh'|'en'}) {
  const zh=locale==='zh';
  if(!records.length)return null;
  return <div className="upload-record-summaries"><p>{zh?'以下记录需管理员按编号核对。':'Ask an administrator to check these record IDs.'}</p><ul>{records.map(record=><li key={`${record.kind}:${record.id}`}><code>{record.id}</code><span> · {record.reason==='ACCESS_CHANGED'?(zh?'任务权限或状态已变化':'Task access or state changed'):record.reason==='INVALID_METADATA'?(zh?'记录信息待核对':'Metadata needs review'):(zh?'历史上传待核对':'Historical upload needs review')}</span></li>)}</ul></div>;
}
