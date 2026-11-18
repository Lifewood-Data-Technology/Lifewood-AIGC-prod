import {directoryRecord,type DirectoryRecord} from './admin-directory';
import {filterActiveAdminMenus} from './admin-menu-routes';
/** Initial records mirror existing destinations; creating a menu never grants a capability. */
export function initialAdminMenus():DirectoryRecord[]{
 const groups=[['system-group','系统管理',null,1],['log-group','日志管理','system-group',7],['security-group','安全与运维',null,2]] as const;
 const pages=[['dashboard','工作台',null],['accounts','用户管理','system-group'],['access','角色管理','system-group'],['menus','菜单管理','system-group'],['departments','部门管理','system-group'],['audit','操作日志','log-group'],['login-logs','登录日志','log-group'],['sessions','登录监控','security-group'],['security','安全设置','security-group'],['backups','备份与恢复','security-group'],['upload-recovery','上传异常处理','security-group']] as const;
 return [...groups.map(([id,name,parentId,order])=>({...directoryRecord(id,name),code:id,parentId,order,menuType:'directory' as const,icon:id,builtin:true})),...pages.map(([id,name,parentId],order)=>({...directoryRecord('nav-'+id,name),code:'nav.'+id,parentId,order,route:'/'+id,icon:id,builtin:true}))];
}
/** Add the newly connected operations destination without rewriting saved menu configuration. */
export function uploadRecoveryMenus(records:DirectoryRecord[]):DirectoryRecord[] {
 if(records.some(record=>record.route==='/upload-recovery'))return records;
 const item=initialAdminMenus().find(record=>record.route==='/upload-recovery')!;
 return [...records,{...item,parentId:records.some(record=>record.id==='security-group')?'security-group':null}];
}
export type AdminNavNode={id:string;label:string;icon:string;route:string|null;children:AdminNavNode[]};
export function adminNavigationTree(records:DirectoryRecord[],labels:Record<string,string>,locale:'zh'|'en'='zh'):AdminNavNode[]{
 const activeRecords=filterActiveAdminMenus(records);
 const walk=(parentId:string|null,seen:Set<string>):AdminNavNode[]=>activeRecords.filter(r=>r.parentId===parentId&&r.enabled&&!r.hidden&&r.menuType!=='action'&&!seen.has(r.id)).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).flatMap(r=>{
  const route=r.menuType==='page'?r.route.replace(/^\//,''):null;
  if(route&&!Object.hasOwn(labels,route))return [];
  const children=walk(r.id,new Set([...seen,r.id]));if(!route&&!children.length)return [];
  return [{id:r.id,label:route&&locale==='en'&&r.builtin?labels[route]:r.name,icon:r.icon,route,children}];
 });return walk(null,new Set());
}

/** The same tree drives current-page expansion for both initial and saved navigation. */
export function adminNavigationAncestors(nodes:AdminNavNode[],route:string):string[] {
 for(const node of nodes){
  if(node.route===route)return [];
  const nested=adminNavigationAncestors(node.children,route);
  if(nested.length||node.children.some(child=>child.route===route))return [node.id,...nested];
 }
 return [];
}
