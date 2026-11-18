import type {Database} from './database';
import type {UploadRecordSummary} from '../lib/upload-recovery';
import {PublicError} from '../lib/security-controls';

/** Only an uploader's record identities, including records no longer writable by that account. */
export async function ownUploadHistory(db:Database,actor:string,cursor='',id='') {
  let after:{kind:string;id:string}|null=null;
  if(cursor){try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!v||!['legacy','staged'].includes(v.kind)||typeof v.id!=='string'||v.id.length>255)throw Error();after=v;}catch{throw new PublicError('Invalid history page.');}}
  const query=`SELECT 'legacy' AS kind,u.id,u.status AS state,u.updated_at FROM upload_sessions u JOIN accounts a ON a.id=u.account_id WHERE a.email=? AND u.status NOT IN ('completed','cancelled','failed','expired') UNION ALL SELECT 'staged' AS kind,s.id,s.state,s.updated_at FROM production_staged_files s WHERE s.actor_email=? AND s.state IN ('uploading','cleanup_claimed') AND NOT EXISTS(SELECT 1 FROM direct_upload_sessions d WHERE d.id=s.id AND d.cleaned_at IS NULL)`;
  const rows=(await db.prepare(`SELECT * FROM (${query}) history WHERE 1=1${id?' AND id=?':''}${after?' AND (kind>? OR (kind=? AND id>?))':''} ORDER BY kind,id LIMIT 51`).bind(actor,actor,...(id?[id]:[]),...(after?[after.kind,after.kind,after.id]:[])).all<{kind:'legacy'|'staged';id:string;state:string;updated_at:string}>()).results;
  const page=rows.slice(0,50),last=page.at(-1);
  return {records:page.map(row=>({id:row.id,kind:row.kind,state:row.state.slice(0,100),updatedAt:row.updated_at,reason:'HISTORICAL_RECORD' as const} satisfies UploadRecordSummary)),nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify({kind:last.kind,id:last.id})).toString('base64url'):null};
}
