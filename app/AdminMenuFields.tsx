"use client";
import type {ActiveDirectoryRecord} from '../lib/admin-directory';
import {adminMenuRoutes} from '../lib/admin-menu-routes';
import AdminIconPicker from './AdminIconPicker';
export default function AdminMenuFields({value,records,locale,change}:{value:ActiveDirectoryRecord;records:ActiveDirectoryRecord[];locale:'zh'|'en';change:(value:ActiveDirectoryRecord)=>void}){
 const zh=locale==='zh';
 return <div className="admin-department-form">
 <label className="admin-full-field"><span>{zh?'上级菜单':'Parent menu'}</span><select value={value.parentId||''} onChange={e=>change({...value,parentId:e.target.value||null})}><option value="">{zh?'主目录':'Root'}</option>{records.filter(r=>r.id!==value.id&&r.enabled&&(r.menuType==='directory'||value.menuType==='action'&&r.menuType==='page')).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
 <div className="admin-radio-field admin-full-field"><span>{zh?'菜单类型':'Menu type'}</span><div role="group" aria-label={zh?'菜单类型':'Menu type'}>{(['directory','page','action'] as const).map((type,index)=><label key={type}><input type="radio" name="menuType" checked={value.menuType===type} onChange={()=>change({...value,menuType:type,parentId:null})}/>{(zh?['目录','菜单','按钮']:['Directory','Page','Action'])[index]}</label>)}</div></div>
 <label><span>{zh?'菜单名称':'Menu name'}</span><input required maxLength={80} value={value.name} onChange={e=>change({...value,name:e.target.value})}/></label>
 <label><span>{zh?'显示排序':'Order'}</span><input required type="number" min={0} max={9999} value={value.order} onChange={e=>change({...value,order:Number(e.target.value)})}/></label>
 <label><span>{zh?'权限标识':'Permission key'}</span><input required disabled={value.builtin} pattern="[a-zA-Z][a-zA-Z0-9_.:\-]*" maxLength={128} value={value.code} onChange={e=>change({...value,code:e.target.value})}/></label>
 {value.menuType!=='action'&&<AdminIconPicker value={value.icon} locale={locale} onChange={icon=>change({...value,icon})}/>}
 {value.menuType==='page'&&<label className="admin-full-field"><span>{zh?'内部路由':'Internal route'}</span><select required value={value.route} onChange={e=>change({...value,route:e.target.value})}><option value="">{zh?'请选择已接入页面':'Select a registered page'}</option>{adminMenuRoutes.filter(route=>!['positions','settings'].includes(route)).map(route=><option key={route} value={'/'+route}>{'/'+route}</option>)}</select></label>}
 <label><span>{zh?'显示状态':'Visibility'}</span><select value={String(value.hidden)} onChange={e=>change({...value,hidden:e.target.value==='true'})}><option value="false">{zh?'显示':'Visible'}</option><option value="true">{zh?'隐藏':'Hidden'}</option></select></label>
 <label><span>{zh?'菜单状态':'Status'}</span><select disabled={value.builtin} value={String(value.enabled)} onChange={e=>change({...value,enabled:e.target.value==='true'})}><option value="true">{zh?'正常':'Enabled'}</option><option value="false">{zh?'停用':'Disabled'}</option></select></label>
 <label className="admin-full-field"><span>{zh?'备注':'Notes'}</span><textarea maxLength={1000} rows={3} value={value.remark} onChange={e=>change({...value,remark:e.target.value})}/></label>
 </div>;
}
