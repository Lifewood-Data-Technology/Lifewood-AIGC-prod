/** Registered workbench destinations. Menu configuration never grants access to a destination. */
export const adminMenuRoutes = ['dashboard','customers','projects','team','standards','files','quality','previews','deliveries','assets','display','notifications','accounts','access','menus','departments','audit','login-logs','sessions','security','backups','upload-recovery','recycle'] as const;
const retiredAdminMenuRoutes = ['positions', 'settings'] as const;

/** Legacy records remain readable while new menu choices use adminMenuRoutes. */
export function isRegisteredMenuRoute(route:string):boolean {
 return [...adminMenuRoutes, ...retiredAdminMenuRoutes].some(id=>route==='/'+id);
}

export function isRetiredAdminMenuRoute(route:string):boolean {
 const destination=route.replace(/^\/+|\/+$/g,'');
 return retiredAdminMenuRoutes.some(id=>destination===id);
}

/** Filter by destination, including custom IDs and descendants, without rewriting history. */
export function filterActiveAdminMenus<T extends {id:string;parentId:string|null;route:string}>(records:T[]):T[] {
 const retired=new Set(records.filter(record=>isRetiredAdminMenuRoute(record.route)).map(record=>record.id));
 let changed=true;
 while(changed){
  changed=false;
  for(const record of records){
   if(record.parentId!==null&&retired.has(record.parentId)&&!retired.has(record.id)){
    retired.add(record.id);
    changed=true;
   }
  }
 }
 return records.filter(record=>!retired.has(record.id));
}
