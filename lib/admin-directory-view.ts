import type {ActiveDirectoryRecord} from './admin-directory';
/** Parent-first ordering keeps each subtree together even when sibling order values overlap. */
export function directoryTree(records:ActiveDirectoryRecord[]):Array<{record:ActiveDirectoryRecord;depth:number}>{
 const result:Array<{record:ActiveDirectoryRecord;depth:number}>=[],seen=new Set<string>();
 const sorted=[...records].sort((a,b)=>a.order-b.order||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
 function visit(record:ActiveDirectoryRecord,depth:number){if(seen.has(record.id))return;seen.add(record.id);result.push({record,depth});for(const child of sorted.filter(r=>r.parentId===record.id))visit(child,depth+1);}
 for(const root of sorted.filter(r=>!r.parentId||!records.some(p=>p.id===r.parentId)))visit(root,0);
 for(const orphan of sorted)visit(orphan,0);
 return result;
}
export function directoryCsv(records:ActiveDirectoryRecord[],zh:boolean){
 const cell=(value:string)=>'"'+(/^[\s]*[=+@-]/.test(value)?"'"+value:value).replace(/"/g,'""')+'"';
 const rows=[zh?['名称','编码','显示顺序','状态']:['Name','Code','Order','Status'],...records.map(r=>[r.name,r.code,String(r.order),r.enabled?(zh?'正常':'Enabled'):(zh?'停用':'Disabled')])];
 return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
/** Server trimming and generated timestamps must not make a confirmed submission appear unknown. */
export function directoryRecordMatches(saved:ActiveDirectoryRecord,submitted:ActiveDirectoryRecord){
 const keys=Object.keys(submitted) as Array<keyof ActiveDirectoryRecord>;
 return keys.filter(key=>key!=='createdAt').every(key=>JSON.stringify(saved[key])===JSON.stringify(key==='name'?submitted.name.trim():submitted[key]));
}
