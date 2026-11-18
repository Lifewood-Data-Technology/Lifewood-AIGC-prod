"use client";
import {useRef,useState} from 'react';
import {MenuIcon} from './MenuIcon';
const options=[
 ['dashboard','工作台','Dashboard'],['users','用户','Users'],['roles','角色','Roles'],['departments','部门','Departments'],['menus','菜单','Menus'],['positions','岗位','Positions'],['parameters','参数','Parameters'],['announcements','公告','Announcements'],['audit','操作日志','Audit log'],['login-logs','登录日志','Login log'],['sessions','登录监控','Sessions'],['security','安全','Security'],['backups','备份','Backups'],['customers','客户','Customers'],['projects','项目','Projects'],['tasks','制作任务','Tasks'],['quality','质检','Quality'],['delivery','交付','Delivery'],['library','视频库','Video library'],['files','文件','Files'],['recycle','回收站','Recycle bin'],
] as const;
export default function AdminIconPicker({value,locale,onChange}:{value:string;locale:'zh'|'en';onChange:(value:string)=>void}){
 const trigger=useRef<HTMLButtonElement>(null);
 const [expanded,setExpanded]=useState(false),[query,setQuery]=useState('');const zh=locale==='zh';
 const current=options.find(option=>option[0]===value);
 const filtered=options.filter(option=>option.join(' ').toLowerCase().includes(query.toLowerCase()));
 return <div className="admin-icon-picker"><span>{zh?'菜单图标':'Menu icon'}</span><button type="button" ref={trigger} className="admin-icon-trigger" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><MenuIcon name={value}/>{current?current[zh?1:2]:value}<span aria-hidden="true">⌄</span></button>{expanded&&<div className="admin-icon-options"><label>{zh?'搜索图标':'Search icons'}<input value={query} onChange={event=>setQuery(event.target.value)} placeholder={zh?'名称或图标标识':'Name or icon key'}/></label><div role="group" aria-label={zh?'可选图标':'Available icons'}>{filtered.map(option=><button type="button" key={option[0]} aria-pressed={value===option[0]} title={option[0]} onClick={()=>{onChange(option[0]);setExpanded(false);setQuery('');trigger.current?.focus();}}><MenuIcon name={option[0]}/><span>{option[zh?1:2]}</span></button>)}</div>{!filtered.length&&<p role="status">{zh?'没有匹配的图标':'No matching icons'}</p>}</div>}</div>;
}
