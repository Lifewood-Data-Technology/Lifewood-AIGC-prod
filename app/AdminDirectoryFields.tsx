"use client";
import type {ActiveDirectoryRecord} from '../lib/admin-directory';
export default function AdminDirectoryFields({value,records,locale,change}:{value:ActiveDirectoryRecord;records:ActiveDirectoryRecord[];locale:'zh'|'en';change:(record:ActiveDirectoryRecord)=>void}){
 const zh=locale==='zh';
 const field=(key:'name'|'manager'|'phone'|'email',label:string,max:number,type='text',required=false)=><label><span>{required&&<em aria-hidden="true">*</em>}{label}</span><input name={key} type={type} required={required} maxLength={max} value={value[key]} onChange={event=>change({...value,[key]:event.target.value})}/></label>;
 return <div className="admin-department-form"><label className="admin-full-field"><span>{zh?'上级部门':'Parent department'}</span><select name="parentId" value={value.parentId||''} onChange={event=>change({...value,parentId:event.target.value||null})}><option value="">{zh?'无（顶级部门）':'None (root)'}</option>{records.filter(record=>record.id!==value.id&&record.enabled).map(record=><option key={record.id} value={record.id}>{record.name}</option>)}</select></label>
 {field('name',zh?'部门名称':'Department name',80,'text',true)}
 <label><span><em aria-hidden="true">*</em>{zh?'显示顺序':'Order'}</span><input name="order" type="number" min={0} max={9999} step={1} required value={value.order} onChange={event=>change({...value,order:Number(event.target.value)})}/></label>
 {field('manager',zh?'负责人':'Manager',80)}{field('phone',zh?'联系电话':'Phone',40,'tel')}{field('email',zh?'邮箱':'Email',254,'email')}
 <div className="admin-radio-field"><span>{zh?'部门状态':'Department status'}</span><div role="group" aria-label={zh?'部门状态':'Department status'}>{[true,false].map(enabled=><label key={String(enabled)}><input type="radio" name="enabled" checked={value.enabled===enabled} onChange={()=>change({...value,enabled})}/>{enabled?(zh?'正常':'Enabled'):(zh?'停用':'Disabled')}</label>)}</div></div>
 <div className="admin-full-field admin-department-scope"><strong>{zh?'数据可见范围':'Data visibility'}</strong><p>{zh?'部门仅用于组织归属。员工仍只查看和处理自己负责的数据，部门成员之间不共享业务资料。':'Departments organize staff only. Employees can only view and handle their own assigned data; membership does not share business records.'}</p></div>
 <label className="admin-full-field"><span>{zh?'备注':'Notes'}</span><textarea name="remark" rows={3} maxLength={1000} value={value.remark} onChange={event=>change({...value,remark:event.target.value})}/></label></div>;
}
