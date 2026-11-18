import {getAccount,requireCapability} from '../../../db/backend';
import {readDirectory,writeDirectory} from '../../../db/admin-directory-store';
import {env} from '../../../runtime/node-environment';
import {authenticatedEmail,apiError} from '../_auth';
import {PublicError,readBoundedJson} from '../../../lib/security-controls';
import {activeDirectorySnapshot,parseDirectoryRecord,DirectoryError,type ActiveDirectoryKind} from '../../../lib/admin-directory';
async function authorize(request:Request){const email=authenticatedEmail(request),actor=await getAccount(email);if(!actor||actor.access!=='system')throw new PublicError('Administrator access required.',403);await requireCapability(actor,'accounts.manage');return email;}
export async function GET(request:Request){try{await authorize(request);const accounts=(await env.DB.prepare('SELECT email,name,access_group,status FROM accounts ORDER BY name').all<{email:string;name:string;access_group:string;status:string}>()).results;return Response.json({directory:activeDirectorySnapshot((await readDirectory(env.DB)).snapshot),accounts},{headers:{'cache-control':'no-store'}});}catch(e){return apiError(e,'Could not load administration configuration.');}}
export async function PATCH(request:Request){try{
 const email=await authorize(request),body=await readBoundedJson(request);
 if(!body||typeof body!=='object'||Array.isArray(body))throw new PublicError('Invalid administration request.');
 const r=body as Record<string,unknown>;
 if(r.kind==='positions'||r.type==='organization'&&Object.hasOwn(r,'positionId'))throw new PublicError('岗位管理已下线 / Position management has been retired.',410,'FEATURE_RETIRED');
 if(r.type==='organization'){
  if(!Number.isSafeInteger(r.revision)||Number(r.revision)<0||typeof r.email!=='string'||r.email.length>254||!(r.departmentId===null||typeof r.departmentId==='string'&&r.departmentId.length>0&&r.departmentId.length<=128)||Object.keys(r).some(key=>!['type','revision','email','departmentId'].includes(key)))throw new PublicError('Invalid organization assignment.');
  const state=(await readDirectory(env.DB)).snapshot;
  const target=await env.DB.prepare('SELECT access_group FROM accounts WHERE email = ?').bind(r.email).first<{access_group:string}>();
  if(!target)throw new PublicError('Account not found.',404);
  const previous=state.memberships.find(member=>member.email===r.email);
  return Response.json({directory:activeDirectorySnapshot(await writeDirectory(env.DB,email,Number(r.revision),{type:'assign',membership:{email:r.email,roleId:previous?.roleId??target.access_group,departmentId:r.departmentId as string|null}},true))},{headers:{'cache-control':'no-store'}});
 }
 if(r.type==='assign'){
  if(!Number.isSafeInteger(r.revision)||Number(r.revision)<0||typeof r.email!=='string'||r.email.length>254||typeof r.roleId!=='string'||r.roleId.length>128||Object.keys(r).some(key=>!['type','revision','email','roleId'].includes(key)))throw new PublicError('Invalid role assignment.');
  const state=(await readDirectory(env.DB)).snapshot;
  const previous=state.memberships.find(member=>member.email===r.email);
  return Response.json({directory:activeDirectorySnapshot(await writeDirectory(env.DB,email,Number(r.revision),{type:'assign',membership:{email:r.email,roleId:r.roleId,departmentId:previous?.departmentId??null}}))},{headers:{'cache-control':'no-store'}});
 }
 if(!Number.isSafeInteger(r.revision)||Number(r.revision)<0||!['roles','departments','menus'].includes(String(r.kind))||!['save','delete'].includes(String(r.type))||Object.keys(r).some(k=>!['revision','kind','type','record','id'].includes(k)))throw new PublicError('Invalid administration request.');
 const kind=r.kind as ActiveDirectoryKind;
 const command=r.type==='save'?{type:'save' as const,kind,record:parseDirectoryRecord(r.record)}:{type:'delete' as const,kind,id:typeof r.id==='string'?r.id:''};
 if(command.type==='delete'&&!command.id)throw new PublicError('Record ID is required.');
 return Response.json({directory:activeDirectorySnapshot(await writeDirectory(env.DB,email,Number(r.revision),command))},{headers:{'cache-control':'no-store'}});
 }catch(e){return apiError(e instanceof DirectoryError?new PublicError(e.message,e.code==='FEATURE_RETIRED'?410:400,e.code):e,'Could not save administration configuration.');}}
