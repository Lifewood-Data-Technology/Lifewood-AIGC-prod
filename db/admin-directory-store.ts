import { prepareAuditStatement } from "./audit-write";
import {initialAdminMenus} from '../lib/admin-navigation-model';
import {adminActions,type AdminAction} from '../lib/admin-authorization';
import type {Database} from './database';
import {guardedMutation} from './mutation-guard';
import {changeDirectory,directoryRecord,parseDirectoryRecord,DirectoryError,type DirectorySnapshot,type DirectoryCommand} from '../lib/admin-directory';
import {PublicError} from '../lib/security-controls';
const storageKey='admin.directory.v1';
export function initialDirectory():DirectorySnapshot {
 const defaults:Record<string,AdminAction[]>={client:['customers.read','customers.write','projects.read','projects.brief','files.read','files.write','delivery.read','delivery.confirm'],project:['customers.read','customers.write','projects.read','projects.write','projects.assign','tasks.read','files.read','files.write','standards.manage'],production:['tasks.read','tasks.produce','files.read','files.write','standards.manage'],quality:['tasks.read','tasks.review','files.read','files.write'],system:[...adminActions]};
 const roles=[['client','销售'],['project','项目负责人'],['production','剪辑师'],['quality','质检员'],['system','管理员']].map(([id,name],order)=>({...directoryRecord(id,name),code:id,order,builtin:true,permissions:defaults[id]}));
 return {revision:0,roles,departments:[],menus:initialAdminMenus(),positions:[],memberships:[],objectDepartments:[]};
}
export async function readDirectory(db:Database):Promise<{snapshot:DirectorySnapshot;raw:string|null}> {
 const row=await db.prepare('SELECT value FROM settings WHERE key = ?').bind(storageKey).first<{value:string}>();
 if(!row)return {snapshot:initialDirectory(),raw:null};
 const value:unknown=JSON.parse(row.value);
 if(!value||typeof value!=='object'||!('revision' in value)||!Number.isSafeInteger(value.revision)||!['roles','departments','menus','positions','memberships','objectDepartments'].every(k=>k in value&&Array.isArray(Reflect.get(value,k))))throw new PublicError('Administration configuration is invalid. Restore a verified configuration.',503,'INVALID_ADMIN_CONFIG');
 const snapshot=value as DirectorySnapshot;
 try{for(const kind of ["roles","departments","menus","positions"] as const)snapshot[kind]=snapshot[kind].map(parseDirectoryRecord);}catch{throw new PublicError("Administration configuration is invalid.",503,"INVALID_ADMIN_CONFIG");}
 if(!snapshot.menus.length)snapshot.menus=initialAdminMenus();
 return {snapshot,raw:row.value};
}
/** Revision plus raw compare protects against lost updates; authority rechecked inside the same batch. */
export async function writeDirectory(db:Database,actorEmail:string,expectedRevision:number,command:DirectoryCommand,organizationOnly=false){
 const current=await readDirectory(db);let next:DirectorySnapshot;
 let accountGuard='',accountValues:(string|number|null)[]=[];
 if(command.type==='assign'){
  const target=await db.prepare("SELECT email,access_group,status,management_revision FROM accounts WHERE email = ?").bind(command.membership.email).first<{email:string;access_group:string;status:string;management_revision:number}>();
  if(!target||target.status!=='active')throw new PublicError('Select an active account.',400);
  const currentRole=current.snapshot.memberships.find(m=>m.email===target.email)?.roleId??target.access_group;
  if(organizationOnly&&command.membership.roleId!==currentRole)throw new PublicError('Account role changed. Reload before saving organization.',409);
  if(target.access_group==='system'||command.membership.roleId==='system')throw new PublicError('Administrator identity must not be changed through role assignment.',400);
  if(!current.snapshot.memberships.some(m=>m.email===target.email))current.snapshot.memberships.push({email:target.email,roleId:target.access_group,departmentId:null,positionId:null});
  accountGuard=" AND EXISTS (SELECT 1 FROM accounts WHERE email = ? AND access_group = ? AND status = 'active' AND management_revision = ?)";
  accountValues=[target.email,target.access_group,target.management_revision];
 }

 try{next=changeDirectory(current.snapshot,expectedRevision,command);}catch(error){if(error instanceof DirectoryError)throw new PublicError(error.message,error.code==='FEATURE_RETIRED'?410:error.code==='STALE_REVISION'?409:400,error.code);throw error;}
 const encoded=JSON.stringify(next),now=new Date().toISOString();
 const authority="EXISTS (SELECT 1 FROM accounts WHERE email = ? AND access_group = 'system' AND status = 'active' AND must_change_password = 0)";
 const unchanged=current.raw===null?'NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)':'EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)';
 await guardedMutation(db,authority+' AND '+unchanged+accountGuard,[actorEmail,storageKey,...(current.raw===null?[]:[current.raw]),...accountValues],[
  ...(command.type==='assign'?[db.prepare('UPDATE accounts SET management_revision = management_revision + 1 WHERE email = ?').bind(command.membership.email)]:[]),
  db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(storageKey,encoded,now),
  prepareAuditStatement(db, 'INSERT INTO audit_logs (action,actor_email,subject,details,created_at) VALUES (?,?,?,?,?)').bind('admin.directory.'+(organizationOnly?'organization':command.type),actorEmail,'kind' in command?command.kind:command.type,JSON.stringify({revision:next.revision,...(command.type==='assign'?{accountEmail:command.membership.email,roleId:command.membership.roleId,departmentId:command.membership.departmentId}:{}),recordId:'record' in command?command.record.id:'id' in command?command.id:undefined}),now),
 ]);
 return next;
}
