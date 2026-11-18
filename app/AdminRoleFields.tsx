"use client";
import {useState} from 'react';
import {adminActions,administratorOnlyActions,type ActiveAdminAction} from '../lib/admin-authorization';
import type {ActiveDirectoryRecord} from '../lib/admin-directory';
const groups=[['customers','客户管理','Customers'],['projects','项目管理','Projects'],['tasks','制作与质检','Production and QC'],['delivery','交付管理','Delivery'],['files','文件管理','Files'],['standards','素材标准','Standards'],['assets','素材库','Asset library'],['users','用户管理','Users'],['roles','角色管理','Roles'],['departments','部门管理','Departments'],['menus','菜单管理','Menus'],['parameters','参数设置','Parameters'],['announcements','通知公告','Announcements'],['logs','日志管理','Logs']];
const actions:Record<string,[string,string]>={brief:['历史需求补充','Legacy brief'],read:['查看','Read'],write:['编辑','Edit'],assign:['分配','Assign'],produce:['制作','Produce'],review:['质检','Review'],confirm:['确认交付','Confirm delivery'],manage:['管理','Manage']};
export default function AdminRoleFields({value,locale,change}:{value:ActiveDirectoryRecord;locale:'zh'|'en';change:(value:ActiveDirectoryRecord)=>void}){
 const selectableActions=adminActions.filter(action=>action!=='announcements.manage'&&(value.id==='system'||!administratorOnlyActions.has(action)));
 const zh=locale==='zh';const [expanded,setExpanded]=useState(true);
 function toggle(items:readonly ActiveAdminAction[],checked:boolean){change({...value,permissions:checked?Array.from(new Set([...value.permissions,...items])):value.permissions.filter(p=>!items.includes(p))});}
 return <div className="admin-role-form">
 <label><span>{zh?'角色名称':'Role name'} *</span><input name="name" required maxLength={80} value={value.name} onChange={e=>change({...value,name:e.target.value})}/></label>
 <label><span>{zh?'权限字符':'Permission key'} *</span><input name="code" required disabled={value.builtin} pattern="[a-zA-Z][a-zA-Z0-9_.:\-]*" maxLength={128} value={value.code} onChange={e=>change({...value,code:e.target.value})}/></label>
 <label><span>{zh?'显示顺序':'Order'} *</span><input name="order" required type="number" min={0} max={9999} value={value.order} onChange={e=>change({...value,order:Number(e.target.value)})}/></label>
 <label><span>{zh?'状态':'Status'}</span><select name="enabled" disabled={value.builtin} value={String(value.enabled)} onChange={e=>change({...value,enabled:e.target.value==='true'})}><option value="true">{zh?'正常':'Enabled'}</option><option value="false">{zh?'停用':'Disabled'}</option></select></label>
 <section className="admin-role-permissions" aria-label={zh?'功能权限':'Function permissions'}><strong>{zh?'功能权限':'Function permissions'}</strong><div className="admin-role-tree-tools"><label><input type="checkbox" checked={selectableActions.every(action=>value.permissions.includes(action))} onChange={e=>toggle(selectableActions,e.target.checked)}/>{zh?'全选 / 全不选':'Select / clear all'}</label><button type="button" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>{expanded?(zh?'折叠':'Collapse'):(zh?'展开':'Expand')}</button></div>
 <div className="admin-role-tree">{groups.filter(([prefix])=>selectableActions.some(action=>action.startsWith(prefix+'.'))).map(([prefix,cn,en])=>{const items=selectableActions.filter(action=>action.startsWith(prefix+'.'));const count=items.filter(action=>value.permissions.includes(action)).length;return <div key={prefix}><label><input type="checkbox" checked={count===items.length} ref={el=>{if(el)el.indeterminate=count>0&&count<items.length;}} onChange={e=>toggle(items,e.target.checked)}/>{zh?cn:en}</label>{expanded&&<div>{items.map(action=><label key={action}><input type="checkbox" checked={value.permissions.includes(action)} onChange={e=>toggle([action],e.target.checked)}/>{actions[action.split('.')[1]][zh?0:1]}</label>)}</div>}</div>;})}</div></section>
 <label><span>{zh?'备注':'Notes'}</span><textarea name="remark" rows={3} maxLength={1000} value={value.remark} onChange={e=>change({...value,remark:e.target.value})}/></label>
 </div>;
}
