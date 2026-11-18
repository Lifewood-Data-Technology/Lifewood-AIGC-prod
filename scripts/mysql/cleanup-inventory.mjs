import {validateEnvironment} from '../../runtime/environment.ts';
import {readFile} from 'node:fs/promises';
import mysql from 'mysql2/promise';
import {mysqlOptions} from '../../db/mysql/config.ts';
import {verifySchema} from './verify-schema.mjs';
import {verifyTriggers} from './verify-triggers.mjs';
import {lex,word,identifier} from '../../db/mysql/sql.ts';
import {migrationNames} from './migrations.mjs';
export async function reviewedMysqlInventory(){
 const location=validateEnvironment();
 const c=await mysql.createConnection(mysqlOptions());
 try{return await reviewedMysqlInventoryWithConnection(c,location);}finally{await c.end();}
}

/** A server-owned connection; the isolated administrator harness uses this for native trigger visibility. */
export async function reviewedMysqlInventoryWithConnection(c,location=validateEnvironment()){
  const [[identity]]=await c.query('SELECT DATABASE() db');
  if(identity.db!==process.env.MYSQL_DATABASE)throw Error('SCHEMA_SCOPE_CHANGED');
  await verifySchema(c);
  const statements=(await Promise.all(migrationNames.map(name=>readFile(new URL('../../db/mysql/migrations/'+name,import.meta.url),'utf8')))).flatMap(s=>s.split('--> statement-breakpoint'));
  await verifyTriggers(c,statements);
  const names=statements.map(s=>lex(s)).filter(ts=>ts.some(t=>word(t,'TRIGGER'))).map(ts=>identifier(ts[ts.findIndex(t=>word(t,'TRIGGER'))+1]));
  const [triggers]=await c.query('SELECT TRIGGER_NAME name,ACTION_STATEMENT `sql` FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME');
  if(triggers.length!==names.length||triggers.some(t=>!names.includes(t.name)))throw Error('SCHEMA_SCOPE_CHANGED');
  const [tables]=await c.query('SHOW FULL TABLES');const schema=[],ledgers=[];
  const metadata=['_lifewood_migrations','_lifewood_bootstrap',...(process.env.MYSQL_DATABASE==='lifewood_aigc_test'?['_lifewood_test_run']:[])];
  for(const t of tables){const [name,type]=Object.values(t);if(type!=='BASE TABLE')throw Error('SCHEMA_SCOPE_CHANGED');if(metadata.includes(name)){const [rows]=await c.query('SELECT * FROM `'+name+'`');ledgers.push({name,rows});}else{const [[ddl]]=await c.query('SHOW CREATE TABLE `'+name+'`');schema.push({name,type:'table',sql:ddl['Create Table']});}}
  schema.push(...triggers.map(t=>({...t,type:'trigger'})));schema.sort((a,b)=>a.name.localeCompare(b.name));
  return {schema,ledgers,storage:{provider:'wasabi',bucket:location.WASABI_BUCKET,endpoint:process.env.WASABI_ENDPOINT}};
}
