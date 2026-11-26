import mysql from 'mysql2/promise';
import {loadEnvironment} from './mysql/environment.mjs';
import {verifySchema} from './mysql/verify-schema.mjs';
import {verifyTriggers} from './mysql/verify-triggers.mjs';
import {mysqlOptions} from '../db/mysql/config.ts';
import {readMigrations} from './mysql/migrations.mjs';
loadEnvironment();
const migrations=await readMigrations();
const c=await mysql.createConnection(mysqlOptions());
try{
 const [[lock]]=await c.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':schema-migration'),0) AS acquired");if(lock.acquired!==1)throw Error('Another migration is running');
 const [tables]=await c.query('SHOW TABLES');
 if(tables.length&&!tables.some(t=>Object.values(t)[0]==='_lifewood_migrations'))throw Error('Unknown nonempty schema; migration stopped without changes');
 if(!tables.length)await c.query('CREATE TABLE _lifewood_migrations (version VARCHAR(40) PRIMARY KEY,sha256 CHAR(64) NOT NULL,completed BOOLEAN NOT NULL DEFAULT FALSE) ENGINE=InnoDB');
 const [history]=await c.query('SELECT * FROM _lifewood_migrations ORDER BY version');
 if(history.some(h=>!migrations.some(m=>m.version===h.version&&m.digest===h.sha256)))throw Error('Unknown migration history; no changes applied');
 if(history.some((h,i)=>h.version!==migrations[i]?.version)||history.slice(0,-1).some(h=>h.completed!==1))throw Error('Non-contiguous migration history; no changes applied');
 const last=history.at(-1);
 if(last?.completed===1){await verifySchema(c,last.version);await verifyTriggers(c,migrations.filter(m=>m.version<=last.version).flatMap(m=>m.statements));}
 for(const migration of migrations){
  const previous=history.find(h=>h.version===migration.version);
  if(previous?.completed===1)continue;
  if(!previous){await c.execute('INSERT INTO _lifewood_migrations(version,sha256) VALUES (?,?)',[migration.version,migration.digest]);for(const statement of migration.statements)await c.query(statement);}
  // The publisher status repair is transactional and idempotent. Schema verification alone cannot detect a rolled-back data repair.
  else if(migration.version==='0011'){for(const statement of migration.statements)await c.query(statement);}
  else if(previous.completed!==1&&!process.argv.includes('--verify-complete'))throw Error('Incomplete migration '+migration.version+'; apply its remaining reviewed administrator DDL, then use --verify-complete');
  await verifySchema(c,migration.version);await verifyTriggers(c,migrations.filter(m=>m.version<=migration.version).flatMap(m=>m.statements));
  if(!previous||previous.completed!==1)await c.execute('UPDATE _lifewood_migrations SET completed=TRUE WHERE version=? AND sha256=?',[migration.version,migration.digest]);
  console.log('Verified schema migration '+migration.version+(previous?.completed===1?' (unchanged)':''));
 }
}catch(error){if(error.code==='ER_BINLOG_CREATE_ROUTINE_NEED_SUPER')throw Error('Tables were preserved. MySQL binary logging requires an administrator to install the trigger DDL; application privileges were not expanded.');throw error;}finally{await c.end();}
