/** Virtual browser capabilities never become application-server file/proxy requests. */
export function browserVideoGuard(pathname:string):Response|null{
  return pathname.startsWith('/__lifewood-video/')?new Response(null,{status:410,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}}):null;
}
