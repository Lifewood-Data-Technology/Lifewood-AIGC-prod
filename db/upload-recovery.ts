import {env} from '../runtime/node-environment';
import {getAccount,mutationAuthority} from './backend';
import {createUploadRecoveryAdmin} from './upload-recovery-admin';
import {PublicError} from '../lib/security-controls';

export async function uploadRecoveryAuthority(operator:string) {
  const actor=await getAccount(operator);
  if(!actor||actor.access!=='system')throw new PublicError('Administrator access required.',403);
  return mutationAuthority(env.DB,actor,'system.manage');
}
export async function uploadRecoveryAdmin() {
  const database=await env.DB.prepare('SELECT DATABASE() AS name').first<{name:string}>();
  if(!database||database.name!==process.env.MYSQL_DATABASE)throw new PublicError('Upload recovery resource mismatch.',503,'UPLOAD_RECOVERY_RESOURCE_MISMATCH');
  return createUploadRecoveryAdmin({db:env.DB,bucket:env.FILES,authorize:uploadRecoveryAuthority,resource:`${database.name}:${process.env.WASABI_BUCKET}:${process.env.WASABI_PREFIX}`});
}
