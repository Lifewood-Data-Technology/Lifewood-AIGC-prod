import {isRegisteredMenuRoute,isRetiredAdminMenuRoute,filterActiveAdminMenus} from './admin-menu-routes.ts';
import {storedAdminActions,isRetiredAdminAction,administratorOnlyActions,type AdminAction,type ActiveAdminAction,type DepartmentScope} from './admin-authorization.ts';
export type DirectoryKind='roles'|'departments'|'menus'|'positions';
export type ActiveDirectoryKind=Exclude<DirectoryKind,'positions'>;
export type DirectoryRecord={id:string;name:string;code:string;enabled:boolean;order:number;parentId:string|null;permissions:AdminAction[];scope:DepartmentScope;selectedDepartmentIds:string[];menuType:'directory'|'page'|'action';route:string;icon:string;hidden:boolean;builtin:boolean;manager:string;phone:string;email:string;remark:string;createdAt:string};
export type DirectoryMembership={email:string;roleId:string;departmentId:string|null;positionId:string|null};
export type ObjectDepartment={kind:'customer'|'project';id:string;departmentId:string|null};
export type DirectorySnapshot={revision:number;roles:DirectoryRecord[];departments:DirectoryRecord[];menus:DirectoryRecord[];positions:DirectoryRecord[];memberships:DirectoryMembership[];objectDepartments:ObjectDepartment[]};
export type ActiveDirectoryMembership=Omit<DirectoryMembership,'positionId'>;
export type ActiveDirectoryRecord=Omit<DirectoryRecord,'permissions'>&{permissions:ActiveAdminAction[]};
export type ActiveDirectorySnapshot={revision:number;roles:ActiveDirectoryRecord[];departments:ActiveDirectoryRecord[];menus:ActiveDirectoryRecord[];memberships:ActiveDirectoryMembership[];objectDepartments:ObjectDepartment[]};
export type DirectoryCommand={type:'save';kind:DirectoryKind;record:DirectoryRecord}|{type:'delete';kind:DirectoryKind;id:string}|{type:'assign';membership:ActiveDirectoryMembership}|{type:'handover';objects:ObjectDepartment[];reason:string};
export class DirectoryError extends Error {code:string;constructor(code:string,message:string){super(message);this.code=code;this.name='DirectoryError';}}
const fail=(code:string,message:string):never=>{throw new DirectoryError(code,message);};
const retired=():never=>fail('FEATURE_RETIRED','岗位管理已下线 / Position management has been retired.');
const scopes:DepartmentScope[]=['legacy','department','descendants','selected','company'];
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max;
export function directoryRecord(id:string,name:string):DirectoryRecord{return {id,name,code:'',enabled:true,order:0,parentId:null,permissions:[],scope:'legacy',selectedDepartmentIds:[],menuType:'page',route:'',icon:'menus',hidden:false,builtin:false,manager:'',phone:'',email:'',remark:'',createdAt:''};}
export function activeDirectoryRecord(id:string,name:string):ActiveDirectoryRecord{return {...directoryRecord(id,name),permissions:[]};}
export function parseDirectoryRecord(value:unknown):DirectoryRecord {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('INVALID_RECORD','Invalid directory record.');
 const r={manager:"",phone:"",email:"",remark:"",createdAt:"",...value} as Record<string,unknown>;
 const fields=Object.keys(directoryRecord('',''));
 if(Object.keys(r).some(k=>!fields.includes(k))||!text(r.id,128)||!r.id||!text(r.name,80)||!String(r.name).trim()||!text(r.code,128)||!text(r.route,160)||!text(r.icon,40)||typeof r.enabled!=='boolean'||typeof r.hidden!=='boolean'||typeof r.builtin!=='boolean'||typeof r.order!=='number'||!Number.isInteger(r.order)||r.order<0||r.order>9999||(r.parentId!==null&&!text(r.parentId,128))||!scopes.includes(r.scope as DepartmentScope)||!['directory','page','action'].includes(String(r.menuType)))return fail('INVALID_RECORD','Invalid directory fields.');
 if(!text(r.manager,80)||!text(r.phone,40)||!text(r.email,254)||!text(r.remark,1000)||!text(r.createdAt,40)||(r.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email))))return fail('INVALID_CONTACT','Invalid contact information.');
 if(!Array.isArray(r.permissions)||r.permissions.some(p=>!storedAdminActions.includes(p))||new Set(r.permissions).size!==r.permissions.length)return fail('INVALID_PERMISSION','Unknown or duplicate permission.');
 if(!Array.isArray(r.selectedDepartmentIds)||r.selectedDepartmentIds.some(id=>!text(id,128))||new Set(r.selectedDepartmentIds).size!==r.selectedDepartmentIds.length)return fail('INVALID_SCOPE','Invalid department selection.');
 return {...r,name:String(r.name).trim()} as DirectoryRecord;
}
/** Public projection never rewrites historical storage or re-exposes retired data. */
export function activeDirectorySnapshot(snapshot:DirectorySnapshot):ActiveDirectorySnapshot {
 const active=(record:DirectoryRecord):ActiveDirectoryRecord=>({...record,permissions:record.permissions.filter((permission):permission is ActiveAdminAction=>!isRetiredAdminAction(permission))});
 return {revision:snapshot.revision,roles:snapshot.roles.map(active),departments:snapshot.departments.map(active),menus:filterActiveAdminMenus(snapshot.menus).map(active),memberships:snapshot.memberships.map(member=>({email:member.email,roleId:member.roleId,departmentId:member.departmentId})),objectDepartments:structuredClone(snapshot.objectDepartments)};
}
function parentValid(records:DirectoryRecord[],record:DirectoryRecord){const seen=new Set([record.id]);let id=record.parentId;while(id){if(seen.has(id))fail('PARENT_CYCLE','Parent would create a cycle.');seen.add(id);const parent=records.find(r=>r.id===id);if(!parent)fail('INVALID_PARENT','Parent does not exist.');if(!parent!.enabled)fail('INVALID_PARENT','Parent is disabled.');id=parent!.parentId;}}
/** Keep at least one visible configuration entry so navigation remains recoverable. */
function hasMenuRecoveryEntry(records:DirectoryRecord[]):boolean {
 return records.some(record=>{
  if(record.menuType!=='page'||record.route!=='/menus')return false;
  let current:DirectoryRecord|undefined=record;const seen=new Set<string>();
  while(current){
   if(!current.enabled||current.hidden||seen.has(current.id))return false;
   seen.add(current.id);
   if(current.parentId===null)return true;
   current=records.find(parent=>parent.id===current!.parentId);
   if(current?.menuType!=='directory')return false;
  }
  return false;
 });
}
/** Called only after authenticated server-side administrator authorization. Does not persist itself. */
export function changeDirectory(state:DirectorySnapshot,expectedRevision:number,command:DirectoryCommand):DirectorySnapshot {
 if('kind' in command&&command.kind==='positions'||command.type==='assign'&&Object.hasOwn(command.membership,'positionId'))retired();
 if(state.revision!==expectedRevision)fail('STALE_REVISION','Directory changed. Reload before saving.');
 const next=structuredClone(state);
 if(command.type==='save'){
  const r=parseDirectoryRecord(command.record),records=next[command.kind],old=records.find(x=>x.id===r.id);
  if(r.permissions.some(permission=>isRetiredAdminAction(permission)&&!old?.permissions.includes(permission)))retired();
  if(!r.code.trim()||!/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(r.code))fail('INVALID_CODE','A stable ASCII code is required.');
  if(records.some(x=>x.id!==r.id&&(x.code===r.code||(x.name===r.name&&x.parentId===r.parentId))))fail('DUPLICATE_RECORD','Code or sibling name already exists.');
  if((!old&&r.builtin)||(old?.builtin&&(!r.builtin||r.code!==old.code||!r.enabled)))fail('PROTECTED_RECORD','Built-in identity cannot be disabled or replaced.');
  if(command.kind==='departments'||command.kind==='menus')parentValid(records,r);
  if(command.kind==='departments'){
   if(r.scope!=='legacy'||r.selectedDepartmentIds.length)fail('DEPARTMENT_SHARING_DISABLED','Department membership does not expand business access.');
   if(r.scope==='selected'&&(!r.selectedDepartmentIds.length||r.selectedDepartmentIds.some(id=>!next.departments.some(d=>d.id===id&&d.enabled))))fail('INVALID_SCOPE','Select enabled departments.');
   if(!r.enabled&&(next.memberships.some(m=>m.departmentId===r.id)||records.some(d=>d.parentId===r.id&&d.enabled)))fail('RECORD_IN_USE','Move members and child departments before disabling.');
  }
  if(command.kind==='roles'&&r.id!=='system'&&r.permissions.some(permission=>!isRetiredAdminAction(permission)&&administratorOnlyActions.has(permission)))fail('ADMINISTRATOR_ONLY','System management permissions are reserved for administrators.');
  if(command.kind==='roles'&&!r.enabled&&next.memberships.some(m=>m.roleId===r.id))fail('RECORD_IN_USE','Reassign members before disabling.');
  if(command.kind==='menus'){
   const activeIds=new Set(filterActiveAdminMenus(records).map(record=>record.id));
   if(isRetiredAdminMenuRoute(r.route)||old&&!activeIds.has(old.id)||r.parentId!==null&&records.some(record=>record.id===r.parentId)&&!activeIds.has(r.parentId))fail('FEATURE_RETIRED','此菜单已下线 / This menu has been retired.');
   if(r.menuType==='page'&&!isRegisteredMenuRoute(r.route))fail('INVALID_ROUTE','Only registered internal routes are allowed.');
   if(records.some(child=>child.parentId===r.id&&(r.menuType==='action'||r.menuType==='page'&&child.menuType!=='action')))fail('INVALID_PARENT','Move incompatible child menus before changing the type.');
   const parent=records.find(m=>m.id===r.parentId);if(parent&&(parent.menuType==='action'||(r.menuType!=='action'&&parent.menuType!=='directory')))fail('INVALID_PARENT','Invalid menu parent type.');
  }
  // Omitted historical permissions are archival data, not an instruction to erase them.
  r.permissions=Array.from(new Set([...r.permissions,...(old?.permissions.filter(isRetiredAdminAction)||[])]));
  r.createdAt=old?.createdAt||new Date().toISOString();
  next[command.kind]=old?records.map(x=>x.id===r.id?r:x):[...records,r];
 }else if(command.type==='delete'){
  const records=next[command.kind],record=records.find(r=>r.id===command.id);if(!record)fail('NOT_FOUND','Record not found.');
  if(command.kind==='menus'&&!filterActiveAdminMenus(records).some(active=>active.id===record!.id))fail('FEATURE_RETIRED','此菜单已下线 / This menu has been retired.');
  if(record!.builtin)fail('PROTECTED_RECORD','Built-in records cannot be deleted.');
  const field=command.kind==='roles'?'roleId':command.kind==='departments'?'departmentId':null;
  if((field&&next.memberships.some(m=>m[field]===command.id))||records.some(r=>r.parentId===command.id)||(command.kind==='departments'&&(next.objectDepartments.some(o=>o.departmentId===command.id)||next.departments.some(d=>d.selectedDepartmentIds.includes(command.id)))))fail('RECORD_IN_USE','Record is referenced. Reassign it first.');
  next[command.kind]=records.filter(r=>r.id!==command.id);
 }else if(command.type==='assign'){
  const m=command.membership;if(!next.memberships.some(x=>x.email===m.email))fail('NOT_FOUND','Account membership not found.');
  if(!next.roles.some(r=>r.id===m.roleId&&r.enabled)||(m.departmentId!==null&&!next.departments.some(d=>d.id===m.departmentId&&d.enabled)))fail('INVALID_ASSIGNMENT','Select an enabled role and department.');
  next.memberships=next.memberships.map(x=>x.email===m.email?{...x,email:m.email,roleId:m.roleId,departmentId:m.departmentId}:x);
  // Customer/project department snapshots intentionally remain unchanged on employee transfer.
 }else{
  if(!command.reason.trim()||command.reason.length>500||!command.objects.length)fail('INVALID_HANDOVER','Handover reason and objects are required.');
  const keys=new Set<string>();for(const object of command.objects){const key=object.kind+':'+object.id;if(keys.has(key))fail('INVALID_HANDOVER','Duplicate handover object.');keys.add(key);if(!next.objectDepartments.some(o=>o.kind===object.kind&&o.id===object.id))fail('NOT_FOUND','Handover object not found.');if(!object.departmentId||!next.departments.some(d=>d.id===object.departmentId&&d.enabled))fail('INVALID_HANDOVER','Target department is unavailable.');}
  next.objectDepartments=next.objectDepartments.map(o=>command.objects.find(x=>x.kind===o.kind&&x.id===o.id)||o);
 }
 if(hasMenuRecoveryEntry(state.menus)&&!hasMenuRecoveryEntry(next.menus))fail('MENU_RECOVERY_REQUIRED','Keep a visible menu-management entry before hiding or moving this menu.');
 next.revision++;return next;
}
