/** Navigation symbols share the current theme colour; labels remain the accessible name. */
const paths: Record<string,string> = {
 home:'M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10', dashboard:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
 users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4',
 roles:'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7zM8 12l3 3 5-6',
 departments:'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
 menus:'M3 4h4v4H3zM11 6h10M3 10h4v4H3zM11 12h10M3 16h4v4H3zM11 18h10',
 positions:'M8 7V3h8v4M3 7h18v14H3zM3 12h18M10 12v3h4v-3',
 parameters:'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
 announcements:'M3 10h4l12-6v16l-12-6H3zM7 14l2 7h4l-2-5M22 9v6',
 audit:'M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5',
 'login-logs':'M10 4h10v16H10M3 12h12M11 8l4 4-4 4',
 sessions:'M3 3h18v13H3zM8 21h8M12 16v5M6 7h4M6 11h8',
 security:'M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
 backups:'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',
 'upload-recovery':'M12 16V3M7 8l5-5 5 5M4 15v6h16v-6',
 customers:'M3 5h18v15H3zM7 9h3v3H7zM6 16h5M14 9h4M14 13h4',
 projects:'M3 6h7l2 3h9v12H3zM3 6V3h7l2 3h9v3',
 tasks:'M8 3h8v4H8zM8 5H4v16h16V5h-4M8 12l2 2 5-5M8 18h8',
 quality:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6M6 10l3 3 5-6',
 delivery:'M3 5h11v14H3zM14 10h4l3 4v5h-7M5 19a2 2 0 1 0 4 0M15 19a2 2 0 1 0 4 0',
 library:'M5 3h16v14H5zM2 7v14h15M11 7l5 3-5 3z',
 files:'M3 6h7l2 3h9v12H3z', recycle:'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
 'system-group':'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
 'business-group':'M3 5h18v16H3zM3 10h18M8 10v11',
 'log-group':'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
};
const aliases:Record<string,string>={uploads:'files',accounts:'users',access:'roles',permissions:'roles',settings:'parameters',notifications:'announcements','security-group':'security',overview:'dashboard',production:'tasks',assets:'library',standards:'audit'};
export function MenuIcon({name}:{name:string}) {return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{flexShrink:0,verticalAlign:'middle'}}><path d={paths[aliases[name]||name]||paths.menus}/></svg>;}
