"use client";
import {MenuIcon} from './MenuIcon';
import {activeAdminTabs} from '../lib/retired-admin-views';
export function adminSection(id:string,locale:'zh'|'en'){
 if(['audit','login-logs'].includes(id))return locale==='zh'?'日志管理':'Logs';
 if(['sessions','security','backups','upload-recovery'].includes(id))return locale==='zh'?'安全与运维':'Security and operations';
 return locale==='zh'?'系统管理':'System management';
}
export default function AdminPageTabs({ids,active,labels,locale,navigate,close}:{ids:string[];active:string;labels:Record<string,string>;locale:'zh'|'en';navigate:(id:string)=>unknown;close:(id:string)=>void}){
 return <nav className="admin-page-tabs" aria-label={locale==='zh'?'已打开的页面':'Open pages'}>{activeAdminTabs(ids).map(id=><div key={id} className={id===active?'selected':''}><button type="button" aria-current={id===active?'page':undefined} onClick={()=>navigate(id)}><MenuIcon name={id}/><span>{labels[id]||id}</span></button>{id!=='dashboard'&&<button type="button" className="admin-tab-close" aria-label={(locale==='zh'?'关闭标签：':'Close tab: ')+(labels[id]||id)} onClick={()=>close(id)}>×</button>}</div>)}</nav>;
}
