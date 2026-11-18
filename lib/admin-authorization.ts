/** Administrator redesign policy. Business lifecycle checks are additional, never bypassed. */
export const adminActions = [
  'customers.read','customers.write','projects.read','projects.write','projects.assign',
  'tasks.read','tasks.produce','tasks.review','delivery.read','delivery.confirm',
  'files.read','files.write','projects.brief','standards.manage','assets.manage','users.manage','roles.manage','departments.manage',
  'menus.manage','parameters.manage','announcements.manage','logs.read',
] as const;
/** Read compatibility only. Retired actions cannot grant active authority. */
export const retiredAdminActions=['positions.manage'] as const;
export const storedAdminActions=[...adminActions,...retiredAdminActions] as const;
export type ActiveAdminAction = typeof adminActions[number];
export function isRetiredAdminAction(action:string):action is typeof retiredAdminActions[number]{return retiredAdminActions.some(retired=>retired===action);}
export const administratorOnlyActions:ReadonlySet<string>=new Set(['users.manage','roles.manage','departments.manage','menus.manage','positions.manage','parameters.manage','announcements.manage','logs.read']);
export type AdminAction = typeof storedAdminActions[number];
export type DepartmentScope = 'legacy'|'department'|'descendants'|'selected'|'company';
export type AdministrationRole = {id:string;name:string;enabled:boolean;permissions:AdminAction[]};
export type AdministrationDepartment = {id:string;parentId:string|null;enabled:boolean;scope:DepartmentScope;selectedDepartmentIds:string[]};
export type AdministrationIdentity = {email:string;enabled:boolean;administrator:boolean;roleId:string|null;departmentId:string|null};
export type AdministrationPolicy = {roles:AdministrationRole[];departments:AdministrationDepartment[]};
export type AuthorizationTarget = {
 kind:'customer'|'project'|'task'|'file'|'delivery'|'administration';
 ownerEmail?:string;departmentId?:string|null;
 /** Derived by the server using existing ownership / assignment rules, never from request JSON. */
 legacyVisible:boolean;legacyWritable:boolean;
 /** A task's responsible staff, or its file / delivery's task assignees. */
 assigneeEmails?:readonly string[];
 taskBound?:boolean;
};
const readActions:ReadonlySet<AdminAction> = new Set(['customers.read','projects.read','tasks.read','delivery.read','files.read','logs.read']);
export function administrationAllowed(policy:AdministrationPolicy,actor:AdministrationIdentity,action:AdminAction,target:AuthorizationTarget):boolean {
 if(!actor.enabled||isRetiredAdminAction(action))return false;
 // This exemption grants authority only. Workflow, file validity and concurrency still apply separately.
 if(actor.administrator)return true;
 const role=policy.roles.find(r=>r.id===actor.roleId);
 if(!role?.enabled||!role.permissions.includes(action))return false;
 if(target.kind==='administration'||administratorOnlyActions.has(action))return false;
 if(target.kind==='task'||target.taskBound){
  if(!target.assigneeEmails?.includes(actor.email))return false;
  return readActions.has(action)?target.legacyVisible:target.legacyWritable;
 }
 // Expanded department visibility is not an implicit permission to edit someone else's work.
 if(!readActions.has(action))return target.legacyWritable;
 // 2026-10-19: departments describe organization only; no department sharing is enabled.
 return target.legacyVisible;
}
/** Migration must preserve existing isolation, including accounts without a department. */
export function migratedDepartment(id:string,parentId:string|null=null):AdministrationDepartment {
 return {id,parentId,enabled:true,scope:'legacy',selectedDepartmentIds:[]};
}
