import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('../../db/mysql/migrations/0002-relationship-guards.sql',import.meta.url),'utf8');
const statements=source.split('--> statement-breakpoint').filter(s=>s.includes('BEFORE UPDATE')).map(s=>{
 const table=s.match(/BEFORE UPDATE ON `([a-z_]+)`/)[1];
 const invalid=s.slice(s.indexOf(' AND (')+5,s.indexOf(' THEN SIGNAL'));
 const signal=s.slice(s.indexOf('THEN SIGNAL'),s.indexOf('END IF;')+7);
 return `CREATE TRIGGER \`trg_${table}_assignment_scope\` BEFORE UPDATE ON \`${table}\` FOR EACH ROW BEGIN\n IF COALESCE(@lifewood_relation_${table},0)=1 AND ${invalid} ${signal}\nEND;`;
});
await writeFile(new URL('../../db/mysql/migrations/0003-assignment-guards.sql',import.meta.url),'-- Preserve SQLite UPDATE OF checks for unchanged assignments through the MySQL driver.\n'+statements.join('\n--> statement-breakpoint\n')+'\n');
